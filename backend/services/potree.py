"""PotreeConverter integration.

Detects the PotreeConverter binary (searches common paths + PATH)
and converts a .laz file into an Entwine Point Tree (EPT) folder
that can be served directly to the Potree viewer.
"""

import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Optional


# ─── Binary Discovery ─────────────────────────────────────────────────────────

_COMMON_PATHS = [
    # Docker/Linux paths
    "/usr/local/bin/PotreeConverter",
    "/usr/bin/PotreeConverter",
    "/opt/PotreeConverter/PotreeConverter",
    # Windows paths
    r"C:\PotreeConverter\PotreeConverter.exe",
    r"C:\Program Files\PotreeConverter\PotreeConverter.exe",
]


def find_potree_converter() -> Optional[str]:
    """Return the absolute path to PotreeConverter, or None if not found."""
    # Prefer env var override
    env = os.environ.get("POTREECONVERTER_PATH")
    if env and Path(env).is_file():
        return env

    # Try PATH
    found = shutil.which("PotreeConverter") or shutil.which("potreeconverter")
    if found:
        return found

    # Try well-known locations
    for p in _COMMON_PATHS:
        if Path(p).is_file():
            return p

    return None


def is_available() -> bool:
    return find_potree_converter() is not None


# ─── Conversion ───────────────────────────────────────────────────────────────

class PotreeConvertError(RuntimeError):
    pass


def convert_laz_to_ept(
    laz_path: Path,
    output_dir: Path,
    *,
    progress_callback=None,
) -> Path:
    """Convert a LAZ file to EPT format using PotreeConverter.

    Args:
        laz_path: Path to the input .laz file.
        output_dir: Directory where the EPT folder will be created.
        progress_callback: Optional callable(message: str) for status updates.

    Returns:
        Path to the generated EPT directory (contains ept.json).

    Raises:
        PotreeConvertError: If PotreeConverter is not found or exits non-zero.
    """
    binary = find_potree_converter()
    if not binary:
        raise PotreeConvertError(
            "PotreeConverter not found. Install it or set POTREECONVERTER_PATH."
        )

    ept_dir = output_dir / "entwine_pointcloud"
    ept_dir.mkdir(parents=True, exist_ok=True)

    if progress_callback:
        progress_callback(f"Running PotreeConverter on {laz_path.name}…")

    cmd = [
        binary,
        str(laz_path),
        "-o", str(ept_dir),
        "--generate-page", "false",
    ]

    # PotreeConverter 2.x uses different flags
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=3600,  # 1 hour max
        )
    except FileNotFoundError:
        raise PotreeConvertError(f"PotreeConverter binary not executable: {binary}")
    except subprocess.TimeoutExpired:
        raise PotreeConvertError("PotreeConverter timed out after 1 hour")

    if result.returncode != 0:
        err = (result.stderr or result.stdout or "unknown error").strip()
        raise PotreeConvertError(f"PotreeConverter failed (exit {result.returncode}): {err}")

    if progress_callback:
        progress_callback("PotreeConverter finished.")

    # Verify output
    ept_json = ept_dir / "ept.json"
    if not ept_json.exists():
        # Some versions output into a subdirectory
        for sub in ept_dir.rglob("ept.json"):
            return sub.parent

        raise PotreeConvertError(
            f"PotreeConverter ran but ept.json was not found in {ept_dir}"
        )

    return ept_dir
