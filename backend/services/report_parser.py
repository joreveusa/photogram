"""NodeODM report parser — extracts GCP reprojection errors and accuracy stats.

NodeODM writes a JSON report at:
  odm_report/report.json   (machine-readable)
  odm_report/report.pdf    (human-readable)

This module parses report.json to extract per-GCP errors and overall RMSE.
"""

import json
import re
from pathlib import Path
from typing import Optional


# ─── Structures ───────────────────────────────────────────────────────────────

class GCPError:
    def __init__(self, label: str, error_x: float, error_y: float, error_z: float):
        self.label = label
        self.error_x = error_x
        self.error_y = error_y
        self.error_z = error_z
        self.error_total = (error_x**2 + error_y**2 + error_z**2) ** 0.5


class ReportResult:
    def __init__(self):
        self.gcp_errors: list[GCPError] = []
        self.rmse_x: Optional[float] = None
        self.rmse_y: Optional[float] = None
        self.rmse_z: Optional[float] = None
        self.rmse_total: Optional[float] = None
        self.num_images: Optional[int] = None
        self.reconstruction_accuracy: Optional[float] = None  # m


# ─── Main parser ──────────────────────────────────────────────────────────────

def parse_report(job_output_dir: Path) -> Optional[ReportResult]:
    """Try to parse the NodeODM JSON report from an extracted output directory.

    Looks in:
      <job_output_dir>/extracted/odm_report/report.json
      <job_output_dir>/odm_report/report.json

    Returns a ReportResult, or None if the report is not found / not parseable.
    """
    candidates = [
        job_output_dir / "extracted" / "odm_report" / "report.json",
        job_output_dir / "odm_report" / "report.json",
        job_output_dir / "report.json",
    ]

    for path in candidates:
        if path.exists():
            return _parse_json_report(path)

    return None


def _parse_json_report(path: Path) -> Optional[ReportResult]:
    try:
        with open(path) as f:
            data = json.load(f)
    except Exception:
        return None

    result = ReportResult()

    # Top-level stats
    result.num_images = data.get("images_count") or data.get("photos")

    # Reconstruction accuracy (median reprojection error in meters)
    rec = data.get("reconstruction_statistics") or {}
    result.reconstruction_accuracy = rec.get("average_reprojection_error") or rec.get("median_reprojection_error")

    # GCP errors — NodeODM format: data["gcp_errors"] list
    gcp_list = data.get("gcp_errors") or data.get("gcps") or []
    errors: list[GCPError] = []

    for g in gcp_list:
        label = g.get("point_id") or g.get("label") or g.get("name") or "?"
        ex = abs(float(g.get("error_x") or g.get("dx") or 0))
        ey = abs(float(g.get("error_y") or g.get("dy") or 0))
        ez = abs(float(g.get("error_z") or g.get("dz") or 0))
        errors.append(GCPError(label, ex, ey, ez))

    result.gcp_errors = errors

    # Compute overall RMSE
    if errors:
        n = len(errors)
        result.rmse_x = (sum(e.error_x**2 for e in errors) / n) ** 0.5
        result.rmse_y = (sum(e.error_y**2 for e in errors) / n) ** 0.5
        result.rmse_z = (sum(e.error_z**2 for e in errors) / n) ** 0.5
        result.rmse_total = (
            sum(e.error_total**2 for e in errors) / n
        ) ** 0.5
    else:
        # Fallback: try to read pre-computed RMSE from report
        gcp_stats = data.get("gcp_accuracy") or data.get("gcp_rmse") or {}
        result.rmse_x = gcp_stats.get("rmse_x") or gcp_stats.get("x")
        result.rmse_y = gcp_stats.get("rmse_y") or gcp_stats.get("y")
        result.rmse_z = gcp_stats.get("rmse_z") or gcp_stats.get("z")
        if result.rmse_x and result.rmse_y and result.rmse_z:
            result.rmse_total = (result.rmse_x**2 + result.rmse_y**2 + result.rmse_z**2) ** 0.5

    return result
