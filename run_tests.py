#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
PhotoForge End-to-End Test Suite
Runs a processing job for each available sample dataset and reports results.

Usage:
    python run_tests.py                    # all datasets, fast_preview
    python run_tests.py --preset survey    # survey_grade
    python run_tests.py --dataset aukerman # single dataset
    python run_tests.py --no-wait          # create jobs then exit (don't poll)
"""
import os, sys, time, glob, argparse, json
from datetime import datetime
sys.stdout.reconfigure(encoding="utf-8")

try:
    import requests
except ImportError:
    print("pip install requests")
    sys.exit(1)

BASE        = "http://localhost:8000"
SAMPLE_DIR  = os.path.join(os.path.dirname(__file__), "sample_data")
IMAGE_EXTS  = {".jpg", ".jpeg", ".png", ".tif", ".tiff"}
RESULTS_LOG = os.path.join(os.path.dirname(__file__), "test_results.jsonl")

# ─── Dataset registry ────────────────────────────────────────────────────────

DATASETS = {
    "aukerman": {
        "dir":  os.path.join(SAMPLE_DIR, "odm_data_aukerman-master", "images"),
        "desc": "Agricultural field survey — 77 images, GPS, good overlap",
        "epsg": "EPSG:4326",
    },
    "seneca": {
        "dir":  os.path.join(SAMPLE_DIR, "odm_data_seneca-master", "images"),
        "desc": "SenseFly Swinglet-Cam urban survey",
        "epsg": "EPSG:4326",
    },
    "toledo": {
        "dir":  os.path.join(SAMPLE_DIR, "odm_data_toledo-master", "images"),
        "desc": "Toledo benchmark — 87 images, includes GCPs",
        "epsg": "EPSG:4326",
    },
    "waterbury": {
        "dir":  os.path.join(SAMPLE_DIR, "odm_data_waterbury-master", "images"),
        "desc": "Large split-merge stress test — 248 images",
        "epsg": "EPSG:4326",
    },
}

# ─── Helpers ─────────────────────────────────────────────────────────────────

def hr(char="─", n=62): print(char * n)
def hdr(msg): hr(); print(f"  {msg}"); hr()

def api(method, path, **kw):
    fn = getattr(requests, method)
    r = fn(f"{BASE}{path}", **kw)
    r.raise_for_status()
    return r.json()

def find_images(directory):
    imgs = []
    for f in os.listdir(directory):
        if os.path.splitext(f)[1].lower() in IMAGE_EXTS:
            imgs.append(os.path.join(directory, f))
    return sorted(imgs)

def fmt_dur(seconds):
    m, s = divmod(int(seconds), 60)
    h, m = divmod(m, 60)
    if h: return f"{h}h {m}m {s}s"
    if m: return f"{m}m {s}s"
    return f"{s}s"

def poll_job(jid, name, timeout_min=120):
    """Poll until terminal state. Returns final job dict."""
    deadline = time.time() + timeout_min * 60
    last_line = ""
    while time.time() < deadline:
        try:
            j = api("get", f"/jobs/{jid}", timeout=10)
        except Exception as e:
            print(f"  [poll error: {e}]")
            time.sleep(15)
            continue

        pct  = j["progress"]
        bar  = "█" * int(pct / 5) + "░" * (20 - int(pct / 5))
        step = (j.get("current_step") or j["status"])[:30]
        line = f"  [{bar}] {pct:5.1f}%  {step}"
        if line != last_line:
            ts = datetime.now().strftime("%H:%M:%S")
            print(f"  {ts}  {line}")
            last_line = line

        if j["status"] in ("completed", "failed"):
            return j
        time.sleep(10)

    return api("get", f"/jobs/{jid}", timeout=10)

def save_result(record):
    with open(RESULTS_LOG, "a", encoding="utf-8") as f:
        f.write(json.dumps(record) + "\n")

# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--preset",  default="fast_preview",
                    choices=["fast_preview","survey_grade","high_fidelity"])
    ap.add_argument("--dataset", default=None,
                    help="Run single dataset by name (aukerman|seneca|toledo|waterbury)")
    ap.add_argument("--no-wait", action="store_true",
                    help="Create jobs then exit without polling")
    args = ap.parse_args()

    # Select datasets
    if args.dataset:
        if args.dataset not in DATASETS:
            print(f"Unknown dataset: {args.dataset}. Choose from: {list(DATASETS)}")
            sys.exit(1)
        to_run = {args.dataset: DATASETS[args.dataset]}
    else:
        to_run = {k: v for k, v in DATASETS.items() if os.path.isdir(v["dir"])}

    if not to_run:
        print("No datasets found in sample_data/. Download them first.")
        sys.exit(1)

    # ── Health check ──────────────────────────────────────────────────────────
    hdr("PhotoForge Test Suite")
    print(f"  Preset:   {args.preset}")
    print(f"  Datasets: {list(to_run)}")
    print(f"  Started:  {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")

    try:
        s = api("get", "/system/stats", timeout=5)
        n = api("get", "/system/nodeodm-status", timeout=5)
        print(f"  Backend:  ✓ online")
        print(f"  NodeODM:  {'✓ online' if n['online'] else '✗ OFFLINE — jobs will fail'}")
        print(f"  CPU:      {s['cpu']['percent']}%  |  "
              f"RAM: {s['memory']['used_gb']}/{s['memory']['total_gb']} GB  |  "
              f"Disk free: {s['disk']['free_gb']} GB")
        if s["gpu"].get("name"):
            print(f"  GPU:      {s['gpu']['name']}  "
                  f"VRAM: {s['gpu']['memory_used_mb']:.0f}/{s['gpu']['memory_total_mb']:.0f} MB")
    except Exception as e:
        print(f"  ✗ Backend not reachable: {e}")
        print("  Run: python start_backend.py")
        sys.exit(1)

    # ── Create + upload all projects ──────────────────────────────────────────
    jobs_created = []
    for name, cfg in to_run.items():
        hr()
        print(f"\n  📁 {name.upper()}")
        print(f"     {cfg['desc']}")

        imgs = find_images(cfg["dir"])
        if not imgs:
            print(f"     ✗ No images found in {cfg['dir']}")
            continue
        print(f"     {len(imgs)} images found")

        # Create project
        proj = api("post", "/projects/",
                   data={"name": f"Test — {name.title()} [{args.preset}]",
                         "description": cfg["desc"],
                         "coordinate_system": cfg["epsg"]},
                   timeout=10)
        pid = proj["id"]
        print(f"     Project: {pid}")

        # Upload images
        print(f"     Uploading {len(imgs)} images...", end="", flush=True)
        t0 = time.time()
        file_handles = [(os.path.basename(p), open(p, "rb"), "image/jpeg") for p in imgs]
        try:
            r = requests.post(
                f"{BASE}/projects/{pid}/upload-images",
                files=[("files", fh) for fh in file_handles],
                timeout=600,
            )
            r.raise_for_status()
            up = r.json()
        finally:
            for _, fh, _ in file_handles:
                fh.close()
        elapsed = time.time() - t0
        print(f" {up['total_images']} images in {fmt_dur(elapsed)}")

        exif = up.get("exif_summary", {})
        if exif:
            gps   = exif.get("has_gps_pct", 0)
            makes = ", ".join(exif.get("camera_makes", [])[:2]) or "?"
            bbox  = exif.get("bbox")
            print(f"     GPS: {gps:.0f}%  Camera: {makes}")
            if bbox:
                lat_span = bbox["max_lat"] - bbox["min_lat"]
                lon_span = bbox["max_lon"] - bbox["min_lon"]
                print(f"     BBox: Δlat={lat_span:.4f}° Δlon={lon_span:.4f}°")

        # Start job
        job = api("post", "/jobs/start",
                  params={"project_id": pid, "preset": args.preset},
                  timeout=10)
        jid = job["id"]
        print(f"     Job:  {jid}  status={job['status']}")
        jobs_created.append({"name": name, "pid": pid, "jid": jid, "imgs": len(imgs), "t_upload": elapsed})

    if not jobs_created:
        print("\nNo jobs created.")
        sys.exit(1)

    if args.no_wait:
        hdr("Jobs queued — exiting (--no-wait)")
        for j in jobs_created:
            print(f"  {j['name']:<12} job={j['jid']}")
        print(f"\nMonitor at: http://localhost:1420")
        sys.exit(0)

    # ── Poll each job ─────────────────────────────────────────────────────────
    summary = []
    for jc in jobs_created:
        hdr(f"RUNNING: {jc['name'].upper()} ({jc['imgs']} images)")
        t_start = time.time()
        final = poll_job(jc["jid"], jc["name"])
        elapsed = time.time() - t_start
        status = final["status"]

        record = {
            "dataset":  jc["name"],
            "preset":   args.preset,
            "images":   jc["imgs"],
            "status":   status,
            "duration": round(elapsed),
            "gcp_rmse": final.get("gcp_rmse_total"),
            "jid":      jc["jid"],
            "pid":      jc["pid"],
            "ts":       datetime.utcnow().isoformat(),
        }

        if status == "completed":
            try:
                outputs = api("get", f"/jobs/{jc['jid']}/outputs", timeout=10)
                record["outputs"] = [{"type": o["output_type"],
                                       "mb": round((o.get("file_size_bytes") or 0)/1e6, 1)}
                                      for o in outputs]
                print(f"\n  ✅ COMPLETED in {fmt_dur(elapsed)}")
                print(f"  Outputs ({len(outputs)}):")
                for o in outputs:
                    mb = (o.get("file_size_bytes") or 0) / 1e6
                    print(f"    {o['output_type']:<20} {mb:7.1f} MB")
                if final.get("gcp_rmse_total"):
                    print(f"  GCP RMSE: {final['gcp_rmse_total']*100:.2f} cm")
            except Exception as e:
                print(f"  (output fetch error: {e})")
        else:
            err = final.get("error_message", "unknown error")
            print(f"\n  ✗ FAILED in {fmt_dur(elapsed)}: {err}")
            record["error"] = err

        save_result(record)
        summary.append(record)

    # ── Final report ──────────────────────────────────────────────────────────
    hdr("TEST SUMMARY")
    print(f"  {'Dataset':<12} {'Images':>6}  {'Status':<10}  {'Duration':>10}  {'RMSE':>8}")
    hr("─")
    for r in summary:
        rmse = f"{r['gcp_rmse']*100:.2f} cm" if r.get("gcp_rmse") else "—"
        icon = "✅" if r["status"] == "completed" else "❌"
        print(f"  {icon} {r['dataset']:<10} {r['images']:>6}  "
              f"{r['status']:<10}  {fmt_dur(r['duration']):>10}  {rmse:>8}")
    hr()
    passed = sum(1 for r in summary if r["status"] == "completed")
    print(f"\n  {passed}/{len(summary)} passed   Results saved → test_results.jsonl")
    print(f"  View in app: http://localhost:1420\n")

if __name__ == "__main__":
    main()
