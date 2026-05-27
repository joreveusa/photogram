"""Celery pipeline task — fully synchronous, Windows + WSL2 compatible.

Phase 2 additions:
  • Publishes progress events to Redis pub/sub channel ``job:<job_id>``
    so the WebSocket endpoint can push them to the browser in real time.
  • Calls PotreeConverter after downloading outputs to produce an EPT
    point cloud directory that Potree.js can stream directly.
"""

import json
import os
import sys
import time
from pathlib import Path
from datetime import datetime

from celery_app import celery_app
from config import OUTPUT_DIR, REDIS_URL
from database import Session, engine
from models import Job, JobStatus, JobOutput, Project, ProjectStatus, GCPPoint
from services.nodeodm import NodeODMClient
from services import potree as potree_svc
from sqlmodel import select


# ─── Redis pub/sub publisher ──────────────────────────────────────────────────

def _get_redis():
    """Return a redis.Redis connection (lazy import so the module loads without redis installed)."""
    try:
        import redis
        return redis.from_url(REDIS_URL, decode_responses=True)
    except Exception:
        return None


def _publish(redis_conn, job_id: str, data: dict):
    """Publish a JSON payload to the Redis channel for this job. Never raises."""
    if redis_conn is None:
        return
    try:
        redis_conn.publish(f"job:{job_id}", json.dumps(data))
    except Exception:
        pass


# ─── Path helpers ─────────────────────────────────────────────────────────────

def _normalize_path(path_str: str) -> Path:
    """Convert Windows path to Linux/WSL2 path if running on Linux."""
    if sys.platform != "linux":
        return Path(path_str)
    p = path_str.replace("\\", "/")
    if len(p) >= 2 and p[1] == ":":
        drive = p[0].lower()
        rest = p[2:].lstrip("/")
        p = f"/mnt/{drive}/{rest}"
    return Path(p)


# ─── DB helpers ───────────────────────────────────────────────────────────────

def _update_job(job_id: str, **kwargs):
    with Session(engine) as session:
        job = session.get(Job, job_id)
        if job:
            for k, v in kwargs.items():
                setattr(job, k, v)
            session.add(job)
            session.commit()


def _update_project_status(project_id: str, status: ProjectStatus):
    with Session(engine) as session:
        proj = session.get(Project, project_id)
        if proj:
            proj.status = status
            proj.updated_at = datetime.utcnow()
            session.add(proj)
            session.commit()


def _job_snapshot(job_id: str) -> dict:
    """Return a lightweight dict snapshot of the job for pub/sub messages."""
    with Session(engine) as session:
        job = session.get(Job, job_id)
        if not job:
            return {}
        return {
            "id": job.id,
            "status": job.status,
            "progress": job.progress,
            "current_step": job.current_step,
            "total_images": job.total_images,
            "error_message": job.error_message,
            "nodeodm_task_id": job.nodeodm_task_id,
            "started_at": job.started_at.isoformat() if job.started_at else None,
            "completed_at": job.completed_at.isoformat() if job.completed_at else None,
        }


# ─── GCP file builder ─────────────────────────────────────────────────────────

def _build_gcp_file(gcps: list, coordinate_system: str = "EPSG:4326") -> str | None:
    """
    Build an ODM-compatible GCP file.

    ODM GCP format (one line per observation):
        <CRS header>
        x y z pixel_x pixel_y image_name

    For projected CRS (State Plane, UTM, etc.) we convert to WGS84 lat/lon
    so ODM doesn't need a PROJ definition at runtime — it always understands
    geographic coordinates.

    Each GCPPoint may have multiple observations stored as a list under the
    'observations' key: [{image, pixel_x, pixel_y}, ...].  Single-observation
    GCPs may still use the legacy image_name / pixel_x / pixel_y keys.
    """
    if not gcps:
        return None

    # Try to convert projected → WGS84 so ODM always sees geographic coords.
    # pyproj is available in the NodeODM container env; fall back gracefully.
    converter = None
    crs = (coordinate_system or "EPSG:4326").strip()
    if crs not in ("EPSG:4326", "WGS84"):
        try:
            from pyproj import Transformer
            converter = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)
        except Exception:
            pass  # pyproj not installed — write native coords with correct header

    # ODM 3.5.6 crashes on a bare "WGS84" header (ref[1] IndexError in location.py).
    # "EPSG:4326" is handled safely by the epsg_match regex that runs first.
    header = "EPSG:4326" if converter else crs
    lines = [header + "\n"]

    for g in gcps:
        x, y, z = float(g["x"]), float(g["y"]), float(g["z"])

        # Convert projected → WGS84 (lon, lat)
        if converter:
            try:
                lon, lat = converter.transform(y, x)  # survey: X=Northing, Y=Easting
                gcp_x, gcp_y = lon, lat
            except Exception:
                gcp_x, gcp_y = x, y
        else:
            gcp_x, gcp_y = x, y

        # Collect all observations: prefer new multi-obs list, fall back to legacy single
        observations = g.get("observations") or []
        if not observations and g.get("image_name"):
            observations = [{
                "image": g["image_name"],
                "pixel_x": g.get("pixel_x", 0),
                "pixel_y": g.get("pixel_y", 0),
            }]

        for obs in observations:
            img = obs.get("image") or obs.get("image_name", "")
            px  = obs.get("pixel_x", 0)
            py  = obs.get("pixel_y", 0)
            if img:
                lines.append(f"{gcp_x} {gcp_y} {z} {px} {py} {img}\n")

    return "".join(lines) if len(lines) > 1 else None


# ─── ODM status mapper ────────────────────────────────────────────────────────

def _map_odm_status(code: int, progress: float) -> JobStatus:
    if code in (10, 20):
        if progress < 20:
            return JobStatus.SFM
        elif progress < 60:
            return JobStatus.DENSE
        else:
            return JobStatus.MERGING
    elif code == 40:
        return JobStatus.COMPLETED
    elif code == 30:
        return JobStatus.FAILED
    return JobStatus.QUEUED


# ─── Main task ────────────────────────────────────────────────────────────────

@celery_app.task(bind=True, name="tasks.pipeline.run_pipeline")
def run_pipeline(self, job_id: str, preset: str = "survey_grade"):
    """Full synchronous pipeline using NodeODM's one-shot POST /task/new.

    Phase 2: publishes real-time progress events to Redis pub/sub channel
    ``job:<job_id>`` at every significant step, so the WebSocket handler can
    forward them to the browser without polling the database.
    """
    client = NodeODMClient()
    redis_conn = _get_redis()
    project_id = None

    def _update_and_publish(step: str, progress: float, status: JobStatus = None, **extra):
        """Update the DB row and publish to Redis in one call."""
        kwargs = {"current_step": step, "progress": progress}
        if status:
            kwargs["status"] = status
        kwargs.update(extra)
        _update_job(job_id, **kwargs)
        payload = _job_snapshot(job_id)
        _publish(redis_conn, job_id, payload)

    try:
        # ── 1. Load job + project ────────────────────────────────────────────
        with Session(engine) as session:
            job = session.get(Job, job_id)
            if not job:
                return
            project = session.get(Project, job.project_id)
            image_dir = _normalize_path(project.image_dir)
            preset = job.preset or preset
            coordinate_system = project.coordinate_system or "EPSG:4326"
            gcps = list(project.gcps) if project.gcps else []
            project_id = job.project_id
            # Phase 3: load custom ODM options + RTK accuracy
            custom_options_json = job.custom_options
            rtk_accuracy_h = project.rtk_accuracy_h
            rtk_accuracy_v = project.rtk_accuracy_v

        _update_and_publish(
            "Gathering images", 1,
            status=JobStatus.SFM,
            started_at=datetime.utcnow(),
        )

        # ── 2. Gather image files ────────────────────────────────────────────
        exts = {".jpg", ".jpeg", ".png", ".tif", ".tiff"}
        image_paths = [p for p in image_dir.iterdir() if p.suffix.lower() in exts]
        image_count = len(image_paths)

        if image_count == 0:
            raise ValueError(f"No images found in {image_dir}")

        _update_and_publish(
            f"Uploading {image_count} images to processing engine", 2,
            total_images=image_count,
        )

        # ── 3. GCP file ──────────────────────────────────────────────────────
        # Build one dict per GCP with all its observations.
        # The DB stores one row per observation (label repeated), so group them.
        gcp_obs_map: dict = {}
        for g in gcps:
            label = g.label
            if label not in gcp_obs_map:
                gcp_obs_map[label] = {"x": g.x, "y": g.y, "z": g.z, "observations": []}
            if g.image_name:
                gcp_obs_map[label]["observations"].append({
                    "image": g.image_name,
                    "pixel_x": g.pixel_x or 0,
                    "pixel_y": g.pixel_y or 0,
                })
        gcp_data = list(gcp_obs_map.values())
        gcp_content = _build_gcp_file(gcp_data, coordinate_system)

        # ── 4. Submit to NodeODM ─────────────────────────────────────────────
        def upload_progress(done, total):
            pct = 2 + (done / max(total, 1)) * 28
            _update_and_publish(f"Uploading {done}/{total} images", pct)

        # Merge custom options on top of preset
        custom_overrides: dict | None = None
        if custom_options_json:
            try:
                import json as _json
                custom_overrides = _json.loads(custom_options_json)
            except Exception:
                pass

        task_uuid = client.submit_task(
            image_paths=image_paths,
            preset=preset,
            gcp_content=gcp_content,
            progress_callback=upload_progress,
            rtk_accuracy_h=rtk_accuracy_h,
            rtk_accuracy_v=rtk_accuracy_v,
            custom_overrides=custom_overrides,
        )
        _update_and_publish(
            "Running Structure from Motion (SfM)", 32,
            status=JobStatus.SFM,
            nodeodm_task_id=task_uuid,
        )

        # ── 5. Poll until done ───────────────────────────────────────────────
        last_publish = 0.0
        while True:
            info = client.get_task_info(task_uuid)
            code = info.get("status", {}).get("code", 0)
            odm_progress = info.get("progress", 0) or 0
            step = info.get("status", {}).get("stepName", "Processing")
            mapped_progress = 32 + (odm_progress / 100.0) * 58
            job_status = _map_odm_status(code, odm_progress)

            _update_job(job_id,
                        progress=mapped_progress,
                        current_step=step,
                        status=job_status)

            # Publish to Redis every 5 s so the WS doesn't spam the browser
            now = time.monotonic()
            if now - last_publish >= 5:
                _publish(redis_conn, job_id, _job_snapshot(job_id))
                last_publish = now

            if code == 40:   # Completed
                _update_and_publish("Processing complete — downloading outputs", 90,
                                    status=JobStatus.INDEXING)
                break
            elif code == 30:  # Failed
                error = info.get("lastError", "Processing engine reported failure")
                _update_job(job_id, status=JobStatus.FAILED,
                            error_message=error, progress=0)
                _publish(redis_conn, job_id, _job_snapshot(job_id))
                _update_project_status(project_id, ProjectStatus.FAILED)
                return

            time.sleep(10)

        # ── 6. Download all.zip + extract deliverables ───────────────────────
        _update_and_publish("Downloading outputs from NodeODM", 92,
                            status=JobStatus.INDEXING)

        output_base = _normalize_path(OUTPUT_DIR) / job_id
        output_base.mkdir(parents=True, exist_ok=True)

        zip_path = output_base / "all.zip"
        try:
            client.download_output(task_uuid, "all.zip", zip_path)
        except Exception as e:
            raise RuntimeError(f"Failed to download outputs: {e}")

        _update_and_publish("Extracting deliverables", 94)

        import zipfile
        extract_dir = output_base / "extracted"
        extract_dir.mkdir(exist_ok=True)
        with zipfile.ZipFile(zip_path, "r") as zf:
            zf.extractall(extract_dir)

        # Map: (zip-relative path, output_type, dest filename)
        deliverables = [
            ("odm_orthophoto/odm_orthophoto.tif",              "orthomosaic", "orthomosaic.tif"),
            ("odm_georeferencing/odm_georeferenced_model.laz", "point_cloud", "point_cloud.laz"),
            ("odm_texturing_25d/odm_textured_model_geo.obj",   "mesh",        "mesh.obj"),
            ("odm_texturing/odm_textured_model_geo.glb",       "mesh_glb",    "mesh.glb"),
            ("odm_dem/dsm.tif",                                "dsm",         "dsm.tif"),
            ("odm_report/report.pdf",                          "report",      "report.pdf"),
        ]

        laz_dest: Path | None = None

        with Session(engine) as session:
            for zip_rel, output_type, local_name in deliverables:
                src = extract_dir / zip_rel
                dest = output_base / local_name
                if src.exists():
                    import shutil
                    shutil.copy2(src, dest)
                    out = JobOutput(
                        job_id=job_id,
                        output_type=output_type,
                        file_path=str(dest),
                        file_size_bytes=dest.stat().st_size,
                    )
                    session.add(out)
                    if output_type == "point_cloud":
                        laz_dest = dest

            # Check for existing EPT from NodeODM (entwine_pointcloud)
            ept_dir = extract_dir / "entwine_pointcloud"
            if ept_dir.exists() and (ept_dir / "ept.json").exists():
                out = JobOutput(
                    job_id=job_id,
                    output_type="ept",
                    file_path=str(ept_dir),
                    file_size_bytes=None,
                )
                session.add(out)
                laz_dest = None  # skip PotreeConverter — we already have EPT

            session.commit()

        # ── 7. PotreeConverter (if LAZ downloaded but no EPT yet) ─────────────
        if laz_dest and laz_dest.exists():
            if potree_svc.is_available():
                _update_and_publish("Indexing point cloud for streaming (PotreeConverter)", 96)
                try:
                    ept_out = potree_svc.convert_laz_to_ept(
                        laz_dest,
                        output_base,
                        progress_callback=lambda msg: _update_and_publish(msg, 97),
                    )
                    with Session(engine) as session:
                        out = JobOutput(
                            job_id=job_id,
                            output_type="ept",
                            file_path=str(ept_out),
                            file_size_bytes=None,
                        )
                        session.add(out)
                        session.commit()
                except potree_svc.PotreeConvertError as e:
                    # Non-fatal: the LAZ file is still available for download
                    _update_and_publish(f"PotreeConverter unavailable ({e}); point cloud available as LAZ", 97)
            else:
                _update_and_publish(
                    "PotreeConverter not installed — point cloud available as LAZ download", 97
                )

        # ── 8. Parse GCP accuracy report ─────────────────────────────────────
        _update_and_publish("Parsing accuracy report", 99)
        try:
            from services.report_parser import parse_report
            report = parse_report(output_base)
            if report:
                update_kwargs = {}
                if report.rmse_x is not None:
                    update_kwargs["gcp_rmse_x"] = report.rmse_x
                    update_kwargs["gcp_rmse_y"] = report.rmse_y
                    update_kwargs["gcp_rmse_z"] = report.rmse_z
                    update_kwargs["gcp_rmse_total"] = report.rmse_total
                if update_kwargs:
                    _update_job(job_id, **update_kwargs)
                # Update per-GCP rows
                if report.gcp_errors:
                    with Session(engine) as session:
                        gcps_db = session.exec(
                            select(GCPPoint).where(GCPPoint.project_id == project_id)
                        ).all()
                        lmap = {g.label: g for g in gcps_db}
                        for err in report.gcp_errors:
                            g = lmap.get(err.label)
                            if g:
                                g.error_x = err.error_x
                                g.error_y = err.error_y
                                g.error_z = err.error_z
                                g.error_total = err.error_total
                                session.add(g)
                        session.commit()
        except Exception as _rpe:
            # Non-fatal — report parsing failure doesn't block completion
            _update_and_publish(f"Report parsing skipped: {_rpe}", 99)

        # ── 9. Done ──────────────────────────────────────────────────────────
        _update_and_publish(
            "Complete", 100,
            status=JobStatus.COMPLETED,
            completed_at=datetime.utcnow(),
        )
        _update_project_status(project_id, ProjectStatus.COMPLETED)

    except Exception as exc:
        _update_job(job_id,
                    status=JobStatus.FAILED,
                    error_message=str(exc))
        _publish(redis_conn, job_id, _job_snapshot(job_id))
        if project_id:
            _update_project_status(project_id, ProjectStatus.FAILED)
        raise
    finally:
        client.close()
        if redis_conn:
            try:
                redis_conn.close()
            except Exception:
                pass
