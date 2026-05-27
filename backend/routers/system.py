"""System stats router — hardware utilization for the UI monitor widget."""

import psutil
import platform
from fastapi import APIRouter

router = APIRouter(prefix="/system", tags=["system"])


@router.get("/stats")
def get_system_stats():
    mem = psutil.virtual_memory()
    disk = psutil.disk_usage(r"S:\Photogram\outputs") if platform.system() == "Windows" else psutil.disk_usage("/outputs")
    cpu = psutil.cpu_percent(interval=0.5)

    # GPU stats via nvidia-smi if available
    gpu_info = _get_gpu_info()

    return {
        "cpu": {
            "percent": cpu,
            "cores": psutil.cpu_count(logical=False),
            "threads": psutil.cpu_count(logical=True),
        },
        "memory": {
            "total_gb": round(mem.total / 1e9, 1),
            "used_gb": round(mem.used / 1e9, 1),
            "percent": mem.percent,
        },
        "disk": {
            "total_gb": round(disk.total / 1e9, 1),
            "used_gb": round(disk.used / 1e9, 1),
            "free_gb": round(disk.free / 1e9, 1),
            "percent": disk.percent,
        },
        "gpu": gpu_info,
    }


@router.get("/nodeodm-status")
def nodeodm_status():
    """Check if NodeODM is reachable."""
    from services.nodeodm import nodeodm_client
    alive = nodeodm_client.health_check()
    return {"online": alive}


@router.get("/potree-status")
def potree_status():
    """Check if PotreeConverter binary is available on this machine."""
    from services.potree import find_potree_converter, is_available
    path = find_potree_converter()
    return {"available": bool(path), "path": path}


def _get_gpu_info() -> dict:
    try:
        import subprocess
        result = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode == 0:
            parts = [p.strip() for p in result.stdout.strip().split(",")]
            if len(parts) >= 5:
                return {
                    "name": parts[0],
                    "utilization_percent": float(parts[1]),
                    "memory_used_mb": float(parts[2]),
                    "memory_total_mb": float(parts[3]),
                    "temperature_c": float(parts[4]),
                }
    except Exception:
        pass
    return {"name": None, "utilization_percent": 0, "memory_used_mb": 0, "memory_total_mb": 0}
