"""Projects router — CRUD for photogrammetry projects."""

import os
import shutil
from pathlib import Path
from typing import List, Optional
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from fastapi.responses import FileResponse
from sqlmodel import Session, select

from database import get_session
from models import Project, ProjectStatus, GCPPoint
from config import OUTPUT_DIR
from services.exif import summarize_dataset

router = APIRouter(prefix="/projects", tags=["projects"])

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".tif", ".tiff"}


# ─── Routes ───────────────────────────────────────────────────────────────────

@router.get("/", response_model=List[dict])
def list_projects(session: Session = Depends(get_session)):
    projects = session.exec(select(Project).order_by(Project.created_at.desc())).all()
    return [_project_dict(p) for p in projects]


@router.post("/", response_model=dict)
def create_project(
    name: str = Form(...),
    description: Optional[str] = Form(None),
    coordinate_system: Optional[str] = Form("EPSG:4326"),
    session: Session = Depends(get_session),
):
    project = Project(
        name=name,
        description=description,
        coordinate_system=coordinate_system,
    )
    # Create staging directory for images
    staging_dir = Path(OUTPUT_DIR) / "staging" / project.id
    staging_dir.mkdir(parents=True, exist_ok=True)
    project.image_dir = str(staging_dir)
    project.output_dir = str(Path(OUTPUT_DIR) / project.id)

    session.add(project)
    session.commit()
    session.refresh(project)
    return _project_dict(project)


@router.get("/{project_id}", response_model=dict)
def get_project(project_id: str, session: Session = Depends(get_session)):
    project = session.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return _project_dict(project)


@router.delete("/{project_id}")
def delete_project(project_id: str, session: Session = Depends(get_session)):
    project = session.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    if project.image_dir and Path(project.image_dir).exists():
        shutil.rmtree(project.image_dir, ignore_errors=True)

    session.delete(project)
    session.commit()
    return {"ok": True}


# ─── Phase 3: RTK/PPK config ──────────────────────────────────────────────────

@router.patch("/{project_id}/rtk-config", response_model=dict)
def update_rtk_config(
    project_id: str,
    rtk_accuracy_h: Optional[float] = None,
    rtk_accuracy_v: Optional[float] = None,
    rtk_mode: Optional[str] = None,
    session: Session = Depends(get_session),
):
    """Update the RTK/PPK accuracy configuration for a project.

    These values are passed to OpenDroneMap as --gps-accuracy when processing.
    """
    project = session.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    if rtk_accuracy_h is not None:
        project.rtk_accuracy_h = rtk_accuracy_h
    if rtk_accuracy_v is not None:
        project.rtk_accuracy_v = rtk_accuracy_v
    if rtk_mode is not None:
        if rtk_mode not in ("rtk", "ppk", "none"):
            raise HTTPException(status_code=400, detail="rtk_mode must be 'rtk', 'ppk', or 'none'")
        project.rtk_mode = rtk_mode

    project.updated_at = datetime.utcnow()
    session.add(project)
    session.commit()
    session.refresh(project)
    return _project_dict(project)


# ─── Images ───────────────────────────────────────────────────────────────────

@router.post("/{project_id}/upload-images", response_model=dict)
async def upload_images(
    project_id: str,
    files: List[UploadFile] = File(...),
    session: Session = Depends(get_session),
):
    project = session.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    staging_dir = Path(project.image_dir)
    staging_dir.mkdir(parents=True, exist_ok=True)

    saved = 0
    for f in files:
        if f.filename and any(
            f.filename.lower().endswith(ext)
            for ext in [".jpg", ".jpeg", ".png", ".tif", ".tiff"]
        ):
            dest = staging_dir / f.filename
            with open(dest, "wb") as out:
                content = await f.read()
                out.write(content)
            saved += 1

    all_images = [
        p for p in staging_dir.iterdir()
        if p.suffix.lower() in {".jpg", ".jpeg", ".png", ".tif", ".tiff"}
    ]
    project.image_count = len(all_images)
    project.updated_at = datetime.utcnow()
    session.add(project)
    session.commit()

    # Phase 3: EXIF summary now includes RTK quality breakdown + accuracy estimates
    summary = summarize_dataset(all_images[:50])

    # Auto-populate RTK accuracy from EXIF if not already set
    if summary.get("avg_acc_h") and not project.rtk_accuracy_h:
        project.rtk_accuracy_h = summary["avg_acc_h"]
        project.rtk_accuracy_v = summary.get("avg_acc_v")
        if summary.get("rtk_fix_pct", 0) > 80:
            project.rtk_mode = "rtk"

    # Phase 4: persist EXIF bounding box
    bbox = summary.get("bbox")
    if bbox:
        project.bbox_min_lat = bbox["min_lat"]
        project.bbox_max_lat = bbox["max_lat"]
        project.bbox_min_lon = bbox["min_lon"]
        project.bbox_max_lon = bbox["max_lon"]
        # Rough area estimate using Haversine
        import math
        dlat = math.radians(bbox["max_lat"] - bbox["min_lat"])
        dlon = math.radians(bbox["max_lon"] - bbox["min_lon"])
        mid_lat = math.radians((bbox["min_lat"] + bbox["max_lat"]) / 2)
        a = dlat * 6371  # km N-S
        b = dlon * 6371 * math.cos(mid_lat)  # km E-W
        project.area_km2 = round(a * b, 4)

    session.add(project)
    session.commit()

    return {
        "uploaded": saved,
        "total_images": project.image_count,
        "exif_summary": summary,
    }


# ─── GCPs ─────────────────────────────────────────────────────────────────────

@router.post("/{project_id}/gcps", response_model=dict)
def save_gcps(
    project_id: str,
    gcps: List[dict],
    session: Session = Depends(get_session),
):
    project = session.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    existing = session.exec(select(GCPPoint).where(GCPPoint.project_id == project_id)).all()
    for g in existing:
        session.delete(g)

    for g in gcps:
        gcp = GCPPoint(
            project_id=project_id,
            label=g.get("label", ""),
            x=float(g["x"]),
            y=float(g["y"]),
            z=float(g["z"]),
            pixel_x=g.get("pixel_x"),
            pixel_y=g.get("pixel_y"),
            image_name=g.get("image_name"),
        )
        session.add(gcp)

    session.commit()
    return {"saved": len(gcps)}


@router.get("/{project_id}/gcps", response_model=List[dict])
def get_gcps(project_id: str, session: Session = Depends(get_session)):
    gcps = session.exec(select(GCPPoint).where(GCPPoint.project_id == project_id)).all()
    return [_gcp_dict(g) for g in gcps]


# ─── Image gallery endpoints ──────────────────────────────────────────────────

@router.get("/{project_id}/images", response_model=List[dict])
def list_images(project_id: str, session: Session = Depends(get_session)):
    """Return a list of uploaded image filenames and sizes for the gallery."""
    project = session.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    staging_dir = Path(project.image_dir) if project.image_dir else None
    if not staging_dir or not staging_dir.exists():
        return []

    images = []
    for p in sorted(staging_dir.iterdir()):
        if p.suffix.lower() in IMAGE_EXTS:
            images.append({
                "filename": p.name,
                "size_bytes": p.stat().st_size,
            })
    return images


@router.get("/{project_id}/thumbnail/{filename}")
def get_thumbnail(
    project_id: str,
    filename: str,
    session: Session = Depends(get_session),
):
    """Serve an image file directly. For large TIFFs the browser will handle scaling."""
    project = session.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    staging_dir = Path(project.image_dir) if project.image_dir else None
    if not staging_dir:
        raise HTTPException(status_code=404, detail="No image directory")

    # Security: only allow basenames, no path traversal
    safe_name = Path(filename).name
    image_path = staging_dir / safe_name

    if not image_path.exists() or image_path.suffix.lower() not in IMAGE_EXTS:
        raise HTTPException(status_code=404, detail="Image not found")

    media_type = "image/jpeg"
    if image_path.suffix.lower() in {".png"}:
        media_type = "image/png"
    elif image_path.suffix.lower() in {".tif", ".tiff"}:
        media_type = "image/tiff"

    return FileResponse(str(image_path), media_type=media_type)


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _gcp_dict(g: GCPPoint) -> dict:
    return {
        "id": g.id, "label": g.label,
        "x": g.x, "y": g.y, "z": g.z,
        "pixel_x": g.pixel_x, "pixel_y": g.pixel_y,
        "image_name": g.image_name,
        # Phase 3: per-GCP accuracy results
        "error_x": g.error_x,
        "error_y": g.error_y,
        "error_z": g.error_z,
        "error_total": g.error_total,
    }


def _project_dict(p: Project) -> dict:
    return {
        "id": p.id,
        "name": p.name,
        "description": p.description,
        "status": p.status,
        "coordinate_system": p.coordinate_system,
        "image_count": p.image_count,
        "image_dir": p.image_dir,
        "output_dir": p.output_dir,
        "area_acres": p.area_acres,
        "created_at": p.created_at.isoformat(),
        "updated_at": p.updated_at.isoformat(),
        "job_count": len(p.jobs) if p.jobs else 0,
        "gcp_count": len(p.gcps) if p.gcps else 0,
        # Phase 3: RTK config
        "rtk_accuracy_h": p.rtk_accuracy_h,
        "rtk_accuracy_v": p.rtk_accuracy_v,
        "rtk_mode": p.rtk_mode,
        # Phase 4: bbox
        "bbox": {
            "min_lat": p.bbox_min_lat,
            "max_lat": p.bbox_max_lat,
            "min_lon": p.bbox_min_lon,
            "max_lon": p.bbox_max_lon,
        } if p.bbox_min_lat is not None else None,
        "area_km2": p.area_km2,
    }
