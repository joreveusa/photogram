"""Jobs router — start processing jobs, poll status, WebSocket live updates."""

import asyncio
import json
from typing import List, Optional
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlmodel import Session, select
from pathlib import Path

from database import get_session, engine
from models import Job, JobStatus, JobOutput, Project, ProcessingPreset, ProjectStatus
from tasks.pipeline import run_pipeline
from config import OUTPUT_DIR

router = APIRouter(prefix="/jobs", tags=["jobs"])


# ─── Routes ───────────────────────────────────────────────────────────────────

@router.post("/start", response_model=dict)
def start_job(
    project_id: str,
    preset: str = "survey_grade",
    custom_options: Optional[str] = None,   # JSON string of extra ODM options
    session: Session = Depends(get_session),
):
    """Start a processing job.

    Args:
        custom_options: Optional JSON string of extra NodeODM option overrides,
                        e.g. '{"pc-quality": "ultra", "mesh-size": 500000}'.
                        These are merged on top of the preset defaults.
    """
    project = session.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if project.image_count == 0:
        raise HTTPException(status_code=400, detail="No images uploaded to this project")

    # Validate custom_options JSON
    if custom_options:
        try:
            json.loads(custom_options)
        except ValueError:
            raise HTTPException(status_code=400, detail="custom_options must be valid JSON")

    # Create job record
    job = Job(
        project_id=project_id,
        preset=ProcessingPreset(preset),
        status=JobStatus.QUEUED,
        total_images=project.image_count,
        custom_options=custom_options,
    )
    session.add(job)

    # Update project status
    project.status = ProjectStatus.PROCESSING
    project.updated_at = datetime.utcnow()
    session.add(project)
    session.commit()
    session.refresh(job)

    # Enqueue Celery task
    task = run_pipeline.delay(job.id, preset)
    job.celery_task_id = task.id
    session.add(job)
    session.commit()

    return _job_dict(job)


@router.get("/queue", response_model=List[dict])
def get_job_queue(session: Session = Depends(get_session)):
    """Return all non-terminal jobs across all projects, ordered oldest-first (queue order)."""
    terminal = [JobStatus.COMPLETED, JobStatus.FAILED]
    jobs = session.exec(
        select(Job)
        .where(Job.status.not_in(terminal))
        .order_by(Job.created_at.asc())
    ).all()
    return [_job_dict(j) for j in jobs]


@router.get("/all", response_model=List[dict])
def list_all_jobs(
    limit: int = 50,
    session: Session = Depends(get_session),
):
    """Return the most recent jobs across all projects (for the dashboard history view)."""
    jobs = session.exec(
        select(Job).order_by(Job.created_at.desc()).limit(limit)
    ).all()
    return [_job_dict(j) for j in jobs]


@router.get("/project/{project_id}", response_model=List[dict])
def list_project_jobs(project_id: str, session: Session = Depends(get_session)):
    jobs = session.exec(
        select(Job).where(Job.project_id == project_id).order_by(Job.created_at.desc())
    ).all()
    return [_job_dict(j) for j in jobs]


@router.get("/{job_id}", response_model=dict)
def get_job(job_id: str, session: Session = Depends(get_session)):
    job = session.get(Job, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return _job_dict(job)


@router.get("/{job_id}/outputs", response_model=List[dict])
def get_job_outputs(job_id: str, session: Session = Depends(get_session)):
    outputs = session.exec(select(JobOutput).where(JobOutput.job_id == job_id)).all()
    return [
        {
            "id": o.id,
            "output_type": o.output_type,
            "file_path": o.file_path,
            "file_size_bytes": o.file_size_bytes,
            "created_at": o.created_at.isoformat(),
        }
        for o in outputs
    ]


@router.get("/{job_id}/download/{output_type}")
def download_output(job_id: str, output_type: str, session: Session = Depends(get_session)):
    output = session.exec(
        select(JobOutput)
        .where(JobOutput.job_id == job_id)
        .where(JobOutput.output_type == output_type)
    ).first()
    if not output:
        raise HTTPException(status_code=404, detail="Output not found")
    p = Path(output.file_path)
    if not p.exists():
        raise HTTPException(status_code=404, detail="Output file missing from disk")
    return FileResponse(p, filename=p.name)


@router.post("/{job_id}/cancel")
def cancel_job(job_id: str, session: Session = Depends(get_session)):
    job = session.get(Job, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.status in (JobStatus.COMPLETED, JobStatus.FAILED):
        raise HTTPException(status_code=400, detail="Cannot cancel a finished job")

    job.status = JobStatus.FAILED
    job.error_message = "Cancelled by user"
    session.add(job)
    session.commit()
    return {"ok": True}


@router.post("/{job_id}/parse-report", response_model=dict)
def parse_gcp_report(job_id: str, session: Session = Depends(get_session)):
    """Parse the NodeODM JSON report for this job and store GCP accuracy results.

    Called automatically by the pipeline after job completion, and also available
    as a manual trigger from the UI.
    """
    from services.report_parser import parse_report
    from models import GCPPoint
    from sqlmodel import select as sel

    job = session.get(Job, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    output_dir = _resolve_path(OUTPUT_DIR) / job_id
    if not output_dir.exists():
        raise HTTPException(status_code=404, detail="Job output directory not found")

    report = parse_report(output_dir)
    if not report:
        return {"parsed": False, "reason": "report.json not found or not parseable"}

    # Store overall RMSE on the job
    job.gcp_rmse_x = report.rmse_x
    job.gcp_rmse_y = report.rmse_y
    job.gcp_rmse_z = report.rmse_z
    job.gcp_rmse_total = report.rmse_total
    session.add(job)

    # Match per-GCP errors back to GCPPoint rows by label
    gcps = session.exec(
        sel(GCPPoint).where(GCPPoint.project_id == job.project_id)
    ).all()
    label_to_gcp = {g.label: g for g in gcps}

    updated = 0
    for err in report.gcp_errors:
        gcp = label_to_gcp.get(err.label)
        if gcp:
            gcp.error_x = err.error_x
            gcp.error_y = err.error_y
            gcp.error_z = err.error_z
            gcp.error_total = err.error_total
            session.add(gcp)
            updated += 1

    session.commit()

    return {
        "parsed": True,
        "gcp_count": len(report.gcp_errors),
        "updated_gcp_rows": updated,
        "rmse_x": report.rmse_x,
        "rmse_y": report.rmse_y,
        "rmse_z": report.rmse_z,
        "rmse_total": report.rmse_total,
        "reconstruction_accuracy": report.reconstruction_accuracy,
    }


@router.get("/{job_id}/gcp-report", response_model=dict)
def get_gcp_report(job_id: str, session: Session = Depends(get_session)):
    """Return stored GCP accuracy results for a completed job."""
    from models import GCPPoint
    from sqlmodel import select as sel

    job = session.get(Job, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    gcps = session.exec(
        sel(GCPPoint).where(GCPPoint.project_id == job.project_id)
    ).all()

    return {
        "rmse_x": job.gcp_rmse_x,
        "rmse_y": job.gcp_rmse_y,
        "rmse_z": job.gcp_rmse_z,
        "rmse_total": job.gcp_rmse_total,
        "gcps": [
            {
                "label": g.label,
                "x": g.x, "y": g.y, "z": g.z,
                "error_x": g.error_x,
                "error_y": g.error_y,
                "error_z": g.error_z,
                "error_total": g.error_total,
            }
            for g in gcps
        ],
    }


@router.get("/{job_id}/ept/{file_path:path}")
def serve_ept_file(job_id: str, file_path: str, session: Session = Depends(get_session)):
    """Serve EPT point cloud files for Potree viewer."""
    import sys
    output = session.exec(
        select(JobOutput)
        .where(JobOutput.job_id == job_id)
        .where(JobOutput.output_type == "ept")
    ).first()
    if not output:
        raise HTTPException(status_code=404, detail="EPT output not found")
    ept_dir = _resolve_path(output.file_path)
    target = ept_dir / file_path
    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail=f"EPT file not found: {file_path}")
    return FileResponse(str(target), headers={"Access-Control-Allow-Origin": "*", "Cache-Control": "max-age=3600"})


def _resolve_path(p: str) -> Path:
    """Normalize a path regardless of whether it was stored from Linux or Windows."""
    import sys
    if sys.platform == 'win32' and p.startswith('/mnt/'):
        # Convert /mnt/s/Photogram/... -> S:\Photogram\...
        parts = p[5:].split('/', 1)
        drive = parts[0].upper()
        rest = parts[1].replace('/', '\\') if len(parts) > 1 else ''
        p = f"{drive}:\\{rest}"
    return Path(p)


@router.post("/{job_id}/register-outputs")
def register_outputs_from_disk(job_id: str, session: Session = Depends(get_session)):
    """Scan the job output directory and register any existing files."""
    import sys
    job = session.get(Job, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    def _norm(p: str) -> Path:
        if sys.platform == 'linux':
            p = p.replace('\\', '/')
            if len(p) >= 2 and p[1] == ':':
                drive = p[0].lower()
                rest = p[2:].lstrip('/')
                return Path(f'/mnt/{drive}/{rest}')
        return Path(p)

    base = _resolve_path(OUTPUT_DIR) / job_id
    if not base.exists():
        raise HTTPException(status_code=404, detail="Output directory not found")

    # Flat files at base dir
    type_map = {
        'orthomosaic.tif': 'orthomosaic',
        'point_cloud.laz': 'point_cloud',
        'mesh.obj':        'mesh',
        'mesh.glb':        'mesh',
        'dsm.tif':         'dsm',
        'report.pdf':      'report',
    }
    # Deep search paths (extracted subdir)
    deep_map = {
        'extracted/odm_orthophoto/odm_orthophoto.tif': 'orthomosaic',
        'extracted/odm_georeferencing/odm_georeferenced_model.laz': 'point_cloud',
        'extracted/odm_report/report.pdf': 'report',
        'extracted/odm_texturing/odm_textured_model_geo.glb': 'mesh',
        'extracted/odm_texturing/odm_textured_model_geo.obj': 'mesh',
        'extracted/odm_texturing_25d/odm_25d_textured_model_geo.glb': 'mesh',
    }

    def _upsert(output_type, fp):
        existing = session.exec(
            select(JobOutput)
            .where(JobOutput.job_id == job_id)
            .where(JobOutput.output_type == output_type)
        ).first()
        fp_str = str(fp)
        size = fp.stat().st_size if fp.exists() else 0
        if existing:
            if _resolve_path(existing.file_path) != fp:
                existing.file_path = fp_str
                existing.file_size_bytes = size
                session.add(existing)
                return 'updated'
            return None
        else:
            session.add(JobOutput(job_id=job_id, output_type=output_type,
                                  file_path=fp_str, file_size_bytes=size))
            return 'new'

    registered = []
    for filename, output_type in type_map.items():
        fp = base / filename
        if fp.exists():
            r = _upsert(output_type, fp)
            if r:
                registered.append(output_type)

    for rel, output_type in deep_map.items():
        fp = base / Path(rel.replace('/', '\\') if sys.platform == 'win32' else rel)
        if fp.exists():
            r = _upsert(output_type, fp)
            if r:
                registered.append(output_type)

    # EPT
    ept_dir = base / 'extracted' / 'entwine_pointcloud'
    if ept_dir.exists():
        r = _upsert('ept', ept_dir)
        if r:
            registered.append('ept')

    session.commit()
    return {"registered": list(set(registered))}



# ─── WebSocket ────────────────────────────────────────────────────────────────

@router.websocket("/ws/{job_id}")
async def job_progress_ws(websocket: WebSocket, job_id: str):
    """Stream real-time job progress to the browser.

    Phase 2: Subscribes to the Redis pub/sub channel ``job:<job_id>``.
    The Celery pipeline publishes a snapshot there whenever progress changes,
    so we forward it immediately — no DB polling while the job is active.

    Falls back to polling the DB every 3 s if Redis is unavailable.
    Sends a final DB snapshot on close so the client always ends in a
    consistent state.
    """
    await websocket.accept()

    loop = asyncio.get_event_loop()

    # ── Try Redis pub/sub mode ────────────────────────────────────────────────
    try:
        import redis.asyncio as aioredis
        from config import REDIS_URL

        client = aioredis.from_url(REDIS_URL, decode_responses=True)
        pubsub = client.pubsub()
        await pubsub.subscribe(f"job:{job_id}")

        try:
            # Send an immediate snapshot from DB
            with Session(engine) as session:
                job = session.get(Job, job_id)
                if job:
                    await websocket.send_json(_job_dict(job))

            # Stream Redis messages; also poll DB every 15 s as a safety net
            async def _db_heartbeat():
                while True:
                    await asyncio.sleep(15)
                    with Session(engine) as session:
                        job = session.get(Job, job_id)
                        if job:
                            await websocket.send_json(_job_dict(job))
                            if job.status in (JobStatus.COMPLETED, JobStatus.FAILED):
                                return

            heartbeat_task = asyncio.create_task(_db_heartbeat())

            async for message in pubsub.listen():
                if message["type"] != "message":
                    continue
                try:
                    data = json.loads(message["data"])
                    await websocket.send_json(data)
                    # Terminal state — stop the stream
                    if data.get("status") in ("completed", "failed"):
                        break
                except Exception:
                    continue

            heartbeat_task.cancel()

        except WebSocketDisconnect:
            pass
        finally:
            await pubsub.unsubscribe(f"job:{job_id}")
            await client.aclose()

    except Exception:
        # ── Fallback: plain DB polling ────────────────────────────────────────
        try:
            while True:
                with Session(engine) as session:
                    job = session.get(Job, job_id)
                    if not job:
                        await websocket.send_json({"error": "Job not found"})
                        break
                    data = _job_dict(job)
                    await websocket.send_json(data)
                    if job.status in (JobStatus.COMPLETED, JobStatus.FAILED):
                        break
                await asyncio.sleep(3)
        except WebSocketDisconnect:
            pass


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _job_dict(j: Job) -> dict:
    return {
        "id": j.id,
        "project_id": j.project_id,
        "status": j.status,
        "preset": j.preset,
        "progress": j.progress,
        "current_step": j.current_step,
        "total_images": j.total_images,
        "split_count": j.split_count,
        "error_message": j.error_message,
        "nodeodm_task_id": j.nodeodm_task_id,
        "celery_task_id": j.celery_task_id,
        "custom_options": j.custom_options,
        "started_at": j.started_at.isoformat() if j.started_at else None,
        "completed_at": j.completed_at.isoformat() if j.completed_at else None,
        "created_at": j.created_at.isoformat(),
        # Phase 3: GCP accuracy
        "gcp_rmse_x": j.gcp_rmse_x,
        "gcp_rmse_y": j.gcp_rmse_y,
        "gcp_rmse_z": j.gcp_rmse_z,
        "gcp_rmse_total": j.gcp_rmse_total,
    }
