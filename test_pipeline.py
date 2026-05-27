# -*- coding: utf-8 -*-
"""
End-to-end test: polls existing queued job, or creates a new one.
Run from: S:\Photogram
"""
import os
import sys
import time
import glob
import requests

# Force UTF-8 output on Windows
sys.stdout.reconfigure(encoding="utf-8")

BASE = "http://localhost:8000"
IMAGE_DIR = r"S:\Photogram\sample_data\odm_data_aukerman-master\images"

def status(msg):
    print(f"\n{'='*60}\n{msg}\n{'='*60}")

# 1. Health check
status("1. Health check")
r = requests.get(f"{BASE}/system/nodeodm-status", timeout=5)
nodeodm = r.json()
print(f"NodeODM online: {nodeodm['online']}")
r = requests.get(f"{BASE}/system/stats", timeout=5)
s = r.json()
print(f"CPU: {s['cpu']['percent']}%  RAM: {s['memory']['used_gb']}/{s['memory']['total_gb']} GB")
print(f"GPU: {s['gpu'].get('name','N/A')}  VRAM: {s['gpu'].get('memory_used_mb',0):.0f}/{s['gpu'].get('memory_total_mb',0):.0f} MB")

# 2. Check for existing queued jobs first
status("2. Checking for existing jobs")
projects = requests.get(f"{BASE}/projects/", timeout=5).json()
existing_job = None
for proj in projects:
    jobs = requests.get(f"{BASE}/jobs/project/{proj['id']}", timeout=5).json()
    for j in jobs:
        if j["status"] not in ("completed", "failed"):
            existing_job = j
            print(f"Found active job: {j['id']}  status={j['status']}  project={proj['name']}")
            break
    if existing_job:
        break

if existing_job:
    jid = existing_job["id"]
    print("Resuming monitoring of existing job...")
else:
    # Create fresh project and upload
    status("3. Creating project")
    r = requests.post(f"{BASE}/projects/", data={
        "name": "Aukerman Test Run",
        "description": "Official ODM sample dataset - 77 images, agricultural field",
        "coordinate_system": "EPSG:4326"
    })
    r.raise_for_status()
    project = r.json()
    pid = project["id"]
    print(f"Project: {pid}  {project['name']}")

    status("4. Uploading images")
    images = sorted(glob.glob(os.path.join(IMAGE_DIR, "*.JPG")) + glob.glob(os.path.join(IMAGE_DIR, "*.jpg")))
    # Deduplicate (glob may return both cases on case-insensitive FS)
    seen, unique = set(), []
    for p in images:
        key = p.lower()
        if key not in seen:
            seen.add(key)
            unique.append(p)
    images = unique
    print(f"Uploading {len(images)} images...")
    files = [("files", (os.path.basename(p), open(p, "rb"), "image/jpeg")) for p in images]
    t0 = time.time()
    r = requests.post(f"{BASE}/projects/{pid}/upload-images", files=files, timeout=300)
    for _, (_, fh, _) in files:
        fh.close()
    r.raise_for_status()
    result = r.json()
    print(f"Uploaded {result['total_images']} images in {time.time()-t0:.1f}s")
    exif = result.get("exif_summary", {})
    if exif:
        print(f"GPS coverage: {exif.get('has_gps_pct',0):.0f}%  Camera: {exif.get('camera_makes',['?'])[0]}")
        bbox = exif.get("bbox", {})
        if bbox:
            print(f"Coverage: lat {bbox['min_lat']:.5f}..{bbox['max_lat']:.5f}  lon {bbox['min_lon']:.5f}..{bbox['max_lon']:.5f}")

    status("5. Starting job (Fast Preview)")
    r = requests.post(f"{BASE}/jobs/start", params={"project_id": pid, "preset": "fast_preview"})
    r.raise_for_status()
    job = r.json()
    jid = job["id"]
    print(f"Job: {jid}  status={job['status']}")

# 6. Poll
status("6. Live pipeline monitor")
print("Open PhotoForge to watch the timeline. Updates every 10s...\n")
last_status = None
while True:
    try:
        job = requests.get(f"{BASE}/jobs/{jid}", timeout=5).json()
    except Exception as e:
        print(f"  [connection error: {e}] retrying...")
        time.sleep(10)
        continue

    pct = job["progress"]
    bar_filled = int(pct / 5)
    bar = "#" * bar_filled + "-" * (20 - bar_filled)
    step = job.get("current_step") or ""
    line = f"  [{bar}] {pct:5.1f}%  {job['status']:<12}  {step}"
    if line != last_status:
        print(line)
        last_status = line

    if job["status"] in ("completed", "failed"):
        break
    time.sleep(10)

status(f"DONE: {job['status'].upper()}")
if job["status"] == "completed":
    outputs = requests.get(f"{BASE}/jobs/{jid}/outputs", timeout=5).json()
    print(f"\nOutputs ({len(outputs)}):")
    for o in outputs:
        mb = (o.get("file_size_bytes") or 0) / 1e6
        print(f"  {o['output_type']:<16} {mb:7.1f} MB  {o['file_path']}")
else:
    print(f"Error: {job.get('error_message','unknown')}")
