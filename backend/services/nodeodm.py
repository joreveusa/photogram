"""NodeODM REST API wrapper — synchronous (requests-based).

Uses POST /task/new (one-shot) to avoid the init/upload/commit split
which has in-memory state that is lost on NodeODM restarts.
"""

import requests
import time
from pathlib import Path
from typing import Optional
from config import NODEODM_URL


# ─── ODM Processing Presets ───────────────────────────────────────────────────

PRESET_OPTIONS = {
    "fast_preview": [
        {"name": "pc-quality",             "value": "lowest"},
        {"name": "mesh-size",              "value": 100000},
        {"name": "orthophoto-resolution",  "value": 10},
        {"name": "fast-orthophoto",        "value": True},
        {"name": "skip-3dmodel",           "value": True},
        {"name": "max-concurrency",        "value": 20},
    ],
    "survey_grade": [
        {"name": "pc-quality",             "value": "high"},
        {"name": "mesh-size",              "value": 300000},
        {"name": "orthophoto-resolution",  "value": 5},
        {"name": "use-3dmesh",             "value": True},
        {"name": "max-concurrency",        "value": 20},
    ],
    "high_fidelity": [
        {"name": "pc-quality",             "value": "ultra"},
        {"name": "mesh-size",              "value": 600000},
        {"name": "orthophoto-resolution",  "value": 2},
        {"name": "use-3dmesh",             "value": True},
        {"name": "build-overviews",        "value": True},
        {"name": "max-concurrency",        "value": 20},
    ],
    # Memory-safe variant: medium quality, conservative concurrency
    "memory_safe": [
        {"name": "pc-quality",             "value": "medium"},
        {"name": "mesh-size",              "value": 200000},
        {"name": "orthophoto-resolution",  "value": 5},
        {"name": "fast-orthophoto",        "value": True},
        {"name": "max-concurrency",        "value": 12},
        {"name": "split",                  "value": 40},
        {"name": "split-overlap",          "value": 20},
    ],
}


def _split_options(image_count: int) -> list:
    # 64GB RAM can handle ~1500-2000 images without splitting
    if image_count <= 1500:
        return []
    split = 1000 if image_count > 3000 else 800
    return [
        {"name": "split",         "value": split},
        {"name": "split-overlap", "value": 20},
    ]


class NodeODMClient:
    def __init__(self, base_url: str = NODEODM_URL):
        self.base_url = base_url.rstrip("/")
        self._session = requests.Session()
        self._session.timeout = 600

    def health_check(self) -> bool:
        try:
            r = self._session.get(f"{self.base_url}/info", timeout=5)
            return r.status_code == 200
        except Exception:
            return False

    def submit_task(
        self,
        image_paths: list,
        preset: str = "survey_grade",
        gcp_content: Optional[str] = None,
        progress_callback=None,
        rtk_accuracy_h: Optional[float] = None,
        rtk_accuracy_v: Optional[float] = None,
        custom_overrides: Optional[dict] = None,
    ) -> str:
        """Submit images using POST /task/new (one-shot, atomic).

        Args:
            rtk_accuracy_h: Horizontal GPS accuracy in metres (→ gps-accuracy).
            rtk_accuracy_v: Vertical GPS accuracy in metres (→ gps-accuracy-vert).
            custom_overrides: Dict of option name→value to merge on top of preset.

        Returns task UUID.
        """
        import json

        options = list(PRESET_OPTIONS.get(preset, PRESET_OPTIONS["survey_grade"]))
        options += _split_options(len(image_paths))

        # Phase 3: inject RTK accuracy options
        if rtk_accuracy_h is not None:
            # ODM gps-accuracy is a single value used for horizontal + vertical
            # Use the tighter of the two, clamp to 0.001 m minimum
            acc = max(0.001, min(rtk_accuracy_h, rtk_accuracy_v or rtk_accuracy_h))
            options.append({"name": "gps-accuracy", "value": round(acc, 4)})

        # Phase 3: merge custom overrides (may override any preset value)
        if custom_overrides:
            existing_names = {o["name"] for o in options}
            for name, value in custom_overrides.items():
                if name in existing_names:
                    # Replace existing option
                    options = [o for o in options if o["name"] != name]
                options.append({"name": name, "value": value})

        files = []
        handles = []

        try:
            # Attach all images
            total = len(image_paths)
            for idx, p in enumerate(image_paths):
                ext = Path(p).suffix.lower()
                mime = (
                    "image/tiff" if ext in (".tif", ".tiff")
                    else "image/png" if ext == ".png"
                    else "image/jpeg"
                )
                fh = open(p, "rb")
                handles.append(fh)
                files.append(("images", (Path(p).name, fh, mime)))
                if progress_callback and idx % 10 == 0:
                    progress_callback(idx, total)

            # GCP file: must be included in the 'images' field named 'gcp_list.txt'
            # NodeODM auto-detects it by filename — a separate 'gcpFile' field
            # is rejected as "Unexpected field" by NodeODM 2.2.4.
            if gcp_content:
                files.append(("images", ("gcp_list.txt", gcp_content.encode(), "text/plain")))

            # options MUST go in data= not files= — NodeODM 2.2.4 rejects
            # it as "Unexpected field" if sent as a multipart file part.
            r = self._session.post(
                f"{self.base_url}/task/new",
                files=files,
                data={"options": json.dumps(options)},
                timeout=600,
            )
            r.raise_for_status()
            if progress_callback:
                progress_callback(total, total)
            data = r.json()
            if "uuid" not in data:
                # NodeODM returned an error body (often with HTTP 200)
                err_msg = data.get("error") or data.get("message") or str(data)
                raise RuntimeError(f"NodeODM rejected task: {err_msg}")
            return data["uuid"]

        finally:
            for fh in handles:
                fh.close()


    def get_task_info(self, task_uuid: str) -> dict:
        r = self._session.get(f"{self.base_url}/task/{task_uuid}/info", timeout=30)
        r.raise_for_status()
        return r.json()

    def cancel_task(self, task_uuid: str) -> None:
        try:
            self._session.post(f"{self.base_url}/task/{task_uuid}/cancel", timeout=30)
        except Exception:
            pass

    def remove_task(self, task_uuid: str) -> None:
        try:
            self._session.post(f"{self.base_url}/task/{task_uuid}/remove", timeout=30)
        except Exception:
            pass

    def download_output(self, task_uuid: str, asset: str, dest_path: Path) -> Path:
        dest_path.parent.mkdir(parents=True, exist_ok=True)
        url = f"{self.base_url}/task/{task_uuid}/download/{asset}"
        with self._session.get(url, stream=True, timeout=600) as r:
            r.raise_for_status()
            with open(dest_path, "wb") as f:
                for chunk in r.iter_content(chunk_size=65536):
                    f.write(chunk)
        return dest_path

    def close(self):
        self._session.close()


# Singleton
nodeodm_client = NodeODMClient()
