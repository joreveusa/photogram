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

    if project.output_dir and Path(project.output_dir).exists():
        shutil.rmtree(project.output_dir, ignore_errors=True)

    # Manually delete related GCPs
    for gcp in project.gcps:
        session.delete(gcp)
        
    # Manually delete related Jobs and their Outputs
    for job in project.jobs:
        for output in job.outputs:
            session.delete(output)
        session.delete(job)

    session.delete(project)
    session.commit()
    return {"ok": True}


@router.patch("/{project_id}", response_model=dict)
def update_project(
    project_id: str,
    payload: dict,
    session: Session = Depends(get_session),
):
    """Rename or update description of a project."""
    project = session.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    if payload.get("name"):
        project.name = payload["name"].strip()
    if "description" in payload:
        project.description = payload["description"]

    project.updated_at = datetime.utcnow()
    session.add(project)
    session.commit()
    session.refresh(project)
    return _project_dict(project)


@router.post("/{project_id}/duplicate", response_model=dict)
def duplicate_project(project_id: str, session: Session = Depends(get_session)):
    """Duplicate a project — copies metadata and GCPs, not images."""
    source = session.get(Project, project_id)
    if not source:
        raise HTTPException(status_code=404, detail="Project not found")

    new_proj = Project(
        name=f"{source.name} (Copy)",
        description=source.description,
        coordinate_system=source.coordinate_system,
        rtk_mode=source.rtk_mode,
        rtk_accuracy_h=source.rtk_accuracy_h,
        rtk_accuracy_v=source.rtk_accuracy_v,
    )
    staging_dir = Path(OUTPUT_DIR) / "staging" / new_proj.id
    staging_dir.mkdir(parents=True, exist_ok=True)
    new_proj.image_dir = str(staging_dir)
    new_proj.output_dir = str(Path(OUTPUT_DIR) / new_proj.id)
    session.add(new_proj)

    # Copy GCPs (coordinates only — image observations reference old filenames)
    source_gcps = session.exec(
        select(GCPPoint).where(GCPPoint.project_id == project_id)
    ).all()
    for g in source_gcps:
        session.add(GCPPoint(
            project_id=new_proj.id,
            label=g.label,
            x=g.x, y=g.y, z=g.z,
            pixel_x=g.pixel_x,
            pixel_y=g.pixel_y,
            image_name=g.image_name,
        ))

    session.commit()
    session.refresh(new_proj)
    return _project_dict(new_proj)


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

    rows_written = 0
    for g in gcps:
        label = g.get("label", "")
        x, y, z = float(g["x"]), float(g["y"]), float(g["z"])

        # Multi-observation format: [{image, pixel_x, pixel_y}, ...]
        observations = g.get("observations") or []

        # Legacy single-observation format
        if not observations and g.get("image_name"):
            observations = [{
                "image": g["image_name"],
                "pixel_x": g.get("pixel_x"),
                "pixel_y": g.get("pixel_y"),
            }]

        if observations:
            for obs in observations:
                img = obs.get("image") or obs.get("image_name")
                session.add(GCPPoint(
                    project_id=project_id,
                    label=label,
                    x=x, y=y, z=z,
                    pixel_x=obs.get("pixel_x"),
                    pixel_y=obs.get("pixel_y"),
                    image_name=img,
                ))
                rows_written += 1
        else:
            # GCP with no observations yet — save coords only
            session.add(GCPPoint(
                project_id=project_id,
                label=label,
                x=x, y=y, z=z,
            ))
            rows_written += 1

    project.updated_at = datetime.utcnow()
    session.add(project)

    session.commit()
    return {"saved": len(gcps), "rows": rows_written}


@router.get("/{project_id}/gcps", response_model=List[dict])
def get_gcps(project_id: str, session: Session = Depends(get_session)):
    rows = session.exec(select(GCPPoint).where(GCPPoint.project_id == project_id)).all()

    # Group rows by label — the DB stores one row per observation
    from collections import OrderedDict
    grouped: OrderedDict = OrderedDict()
    for g in rows:
        if g.label not in grouped:
            grouped[g.label] = {
                "id": g.id,
                "label": g.label,
                "x": g.x, "y": g.y, "z": g.z,
                "observations": [],
                # Legacy single-obs fields (for backward compat)
                "pixel_x": g.pixel_x,
                "pixel_y": g.pixel_y,
                "image_name": g.image_name,
                "error_x": g.error_x,
                "error_y": g.error_y,
                "error_z": g.error_z,
                "error_total": g.error_total,
            }
        if g.image_name:
            grouped[g.label]["observations"].append({
                "image": g.image_name,
                "pixel_x": g.pixel_x,
                "pixel_y": g.pixel_y,
            })

    return list(grouped.values())


# ─── GCP Auto-Detection ───────────────────────────────────────────────────────

@router.post("/{project_id}/gcps/auto-detect", response_model=List[dict])
async def auto_detect_gcps(
    project_id: str,
    payload: dict,
    session: Session = Depends(get_session),
):
    """Run computer-vision GCP target detection on uploaded images.

    Payload fields:
      strategy      : str  — "triangle_cross" | "checkerboard" | "aruco" |
                             "circle_grid" | "template" | "blob"
      gcps          : list — [{label, x, y, z, lat, lon}] (lat/lon are decimal degrees)
      radius_m      : float (default 80) — GPS search radius per GCP
      max_candidates: int   (default 30)  — max images to scan per GCP
      options       : dict  — strategy-specific overrides (cb_pattern, aruco_dict_id, …)
    """
    from services.gcp_detector import run_auto_detect, STRATEGY_CHOICES
    from services.exif import extract_exif

    project = session.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    if not project.image_dir or not Path(project.image_dir).exists():
        raise HTTPException(status_code=400, detail="No images uploaded for this project")

    strategy  = payload.get("strategy", "triangle_cross")
    gcps      = payload.get("gcps", [])
    radius_m  = float(payload.get("radius_m", 80.0))
    max_cands = int(payload.get("max_candidates", 30))
    options   = payload.get("options", {})

    if strategy not in STRATEGY_CHOICES:
        raise HTTPException(
            status_code=400,
            detail=f"strategy must be one of {STRATEGY_CHOICES}"
        )

    if not gcps:
        raise HTTPException(status_code=400, detail="No GCPs provided in payload")

    image_dir = Path(project.image_dir)
    image_paths = sorted(
        p for p in image_dir.iterdir()
        if p.suffix.lower() in IMAGE_EXTS
    )

    if not image_paths:
        raise HTTPException(status_code=400, detail="No images found in project image directory")

    # Build lightweight image metadata list (filename + GPS from EXIF cache)
    image_meta = []
    for p in image_paths:
        exif = extract_exif(p)
        image_meta.append({
            "filename":  p.name,
            "latitude":  exif.get("latitude"),
            "longitude": exif.get("longitude"),
        })

    # Parse strategy-specific options
    cb_pattern   = tuple(options.get("cb_pattern", [4, 4]))
    aruco_dict   = int(options.get("aruco_dict_id", 0))
    aruco_marker = options.get("aruco_marker_id", None)
    cg_pattern   = tuple(options.get("cg_pattern", [4, 4]))
    cg_asym      = bool(options.get("cg_asymmetric", False))
    tmpl_thresh  = float(options.get("template_threshold", 0.65))
    blob_min     = float(options.get("blob_min_area", 500.0))
    blob_max     = float(options.get("blob_max_area", 50000.0))
    spray_color  = str(options.get("spray_color", "pink"))

    # Template upload path (if provided as a stored filename in image_dir)
    template_path = None
    if strategy == "template" and options.get("template_filename"):
        tp = image_dir / options["template_filename"]
        if tp.exists():
            template_path = tp
        else:
            raise HTTPException(status_code=400, detail="Template file not found in project images")

    try:
        results = run_auto_detect(
            image_dir=image_dir,
            image_meta=image_meta,
            gcps=gcps,
            strategy=strategy,
            radius_m=radius_m,
            max_candidates=max_cands,
            cb_pattern=cb_pattern,
            aruco_dict_id=aruco_dict,
            aruco_marker_id=aruco_marker,
            cg_pattern=cg_pattern,
            cg_asymmetric=cg_asym,
            template_path=template_path,
            template_threshold=tmpl_thresh,
            blob_min_area=blob_min,
            blob_max_area=blob_max,
            spray_color=spray_color,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Detection failed: {exc}")

    return results


# ─── Image gallery endpoints ──────────────────────────────────────────────────

@router.get("/{project_id}/images", response_model=List[dict])
def list_images(project_id: str, session: Session = Depends(get_session)):
    """Return uploaded image filenames, sizes, and GPS coordinates from EXIF."""
    project = session.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    staging_dir = Path(project.image_dir) if project.image_dir else None
    if not staging_dir or not staging_dir.exists():
        return []

    images = []
    for p in sorted(staging_dir.iterdir()):
        if p.suffix.lower() in IMAGE_EXTS:
            # Extract per-image EXIF for GPS coords
            from services.exif import extract_exif
            exif = extract_exif(p)
            images.append({
                "filename": p.name,
                "size_bytes": p.stat().st_size,
                "latitude": exif.get("latitude"),
                "longitude": exif.get("longitude"),
                "altitude": exif.get("altitude"),
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
        "gcp_count": len({g.label for g in p.gcps}) if p.gcps else 0,
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
