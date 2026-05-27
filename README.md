# PhotoForge 🛸

**Local photogrammetry processing for drone imagery — survey-grade accuracy, no cloud, no subscription.**

Built on OpenDroneMap (NodeODM), FastAPI, Celery, Redis, and React. Runs entirely on your machine. Ships as a native Windows desktop app (Tauri) or in any browser.

---

## Features

| Feature | Detail |
|---|---|
| **Multi-preset processing** | Fast Preview · Survey Grade · High Fidelity |
| **Split-merge pipeline** | Handles 10,000+ image datasets without RAM overflow |
| **RTK/PPK support** | Auto-detected from EXIF, 2D/3D accuracy config |
| **GCP editor** | Inline table, CSV import, per-point RMSE display |
| **Real-time progress** | WebSocket live updates, pipeline timeline, step log |
| **3D viewer** | GLB mesh + Potree streaming point cloud, measurement tools |
| **Orthomosaic viewer** | Leaflet overlay, GIS export links, NDVI info |
| **Flight planner** | Draw polygon → KML/GPX/CSV export for DJI/Autel |
| **Batch import** | Drop folder-of-folders → multiple projects in one go |
| **Dashboard** | Hardware monitor, GCP accuracy stats, coverage area |
| **Report export** | PDF accuracy report with maps and GIS tips |
| **Desktop app** | Tauri .exe with system tray, native notifications |

---

## Requirements

| Dependency | Version | Notes |
|---|---|---|
| **Docker Desktop** | ≥ 4.20 | Runs backend, NodeODM, Redis, Celery |
| **Python** | ≥ 3.10 | For `start_backend.py` launcher |
| **Node.js** | ≥ 18 | To run / build the frontend |
| **Rust** | ≥ 1.77 | Only needed to build the Tauri `.exe` |
| **NVIDIA GPU** | Optional | RTX recommended; enable in `docker-compose.yml` |
| **PotreeConverter** | Optional | For interactive point cloud streaming |

---

## Quick Start

### 1 — Clone & configure

```powershell
git clone https://github.com/you/photoforge
cd photoforge
cp .env.example .env   # edit OUTPUT_DIR if needed
```

### 2 — Start the backend

```powershell
python start_backend.py
```

This starts Redis, NodeODM, FastAPI, and the Celery worker via Docker Compose, then waits for them to be healthy before printing "All services running."

Alternatively:

```powershell
docker compose up -d
```

### 3 — Run the web app

```powershell
cd frontend
npm install
npm run dev
# → http://localhost:1420
```

### 4 — (Optional) Run as desktop app

```powershell
cd frontend
npm run tauri dev
```

---

## GPU Acceleration

Edit `docker-compose.yml` and uncomment the `deploy:` section under the `nodeodm` service:

```yaml
deploy:
  resources:
    reservations:
      devices:
        - driver: nvidia
          count: all
          capabilities: [gpu]
```

Requires [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html).

---

## PotreeConverter (optional)

Without it, point clouds are available as LAZ downloads only. With it, the 3D viewer streams at interactive frame rates for any dataset size.

**Linux / WSL2:**
```bash
sudo apt install potreeconverter
```

**Manual install:** Download from [github.com/potree/PotreeConverter](https://github.com/potree/PotreeConverter), then set in `.env`:
```
POTREECONVERTER_PATH=/usr/bin/PotreeConverter
```

---

## Architecture

```
┌─────────────────────────────────────┐
│  PhotoForge Desktop (Tauri .exe)    │
│  or browser at localhost:1420       │
│                                     │
│  React + Vite + react-query         │
│  Three.js · Potree · Leaflet        │
└────────────────┬────────────────────┘
                 │ HTTP / WebSocket
┌────────────────▼────────────────────┐
│  FastAPI  (port 8000)               │
│  ├─ /projects  CRUD + image upload  │
│  ├─ /jobs      start / cancel / WS  │
│  └─ /system    stats / health       │
│                                     │
│  Celery Worker                      │
│  └─ tasks/pipeline.py               │
│     split → NodeODM → merge → index │
└──┬──────────────────┬───────────────┘
   │                  │
┌──▼──────┐   ┌───────▼────────────┐
│  Redis  │   │  NodeODM (port 3000)│
│  broker │   │  OpenDroneMap core  │
└─────────┘   └────────────────────┘
```

---

## Project Structure

```
photoforge/
├── backend/
│   ├── main.py              FastAPI app entry point
│   ├── routers/
│   │   ├── projects.py      Project CRUD, images, GCPs
│   │   └── jobs.py          Job lifecycle, WebSocket, outputs
│   ├── tasks/
│   │   └── pipeline.py      Celery pipeline (split → ODM → merge)
│   ├── services/
│   │   └── exif.py          EXIF parsing, RTK quality, BBOX
│   └── models/              SQLModel ORM models
├── frontend/
│   ├── src/
│   │   ├── pages/           Dashboard, ProjectDetail, FlightPlanner, …
│   │   ├── components/      GCPEditor, ImageGallery, MiniMap, ErrorBoundary
│   │   ├── hooks/           useToast, useSettings, useNotification
│   │   └── api.ts           Typed axios client
│   └── src-tauri/           Rust Tauri shell
├── docker-compose.yml
├── start_backend.py         One-click backend launcher
└── .env.example
```

---

## Settings

Open **Settings** in the sidebar to configure:

- **API / NodeODM / WebSocket URLs** — with live connection test
- **Default processing preset** — applied to new jobs
- **Split size & overlap** — tune for your GPU/RAM
- **Auto-start processing** after image upload
- **Desktop notifications** — fires when any job completes

Settings are saved to browser localStorage and survive app restarts.

---

## GCP Workflow

1. Open a project → **Ground Control Points** section
2. Click **Import CSV** (format: `label, easting, northing, elevation`) or **Add GCPs** manually
3. Click **Save**
4. Start a processing job — ODM uses the GCPs for georeferencing
5. After completion, per-point residuals and RMSE are displayed with colour-coded accuracy ratings

**Survey grade threshold:** < 3 cm RMSE total

---

## Building the Installer

```powershell
cd frontend
npm run tauri build
# Outputs:
# src-tauri/target/release/bundle/nsis/PhotoForge_0.4.0_x64-setup.exe
# src-tauri/target/release/bundle/msi/PhotoForge_0.4.0_x64_en-US.msi
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `OUTPUT_DIR` | `./outputs` | Where processed files are stored |
| `REDIS_URL` | `redis://redis:6379/0` | Redis broker URL |
| `NODEODM_URL` | `http://nodeodm:3000` | NodeODM API URL |
| `DATABASE_URL` | `sqlite:///outputs/photoforge.db` | SQLite database path |
| `POTREECONVERTER_PATH` | _(auto-detect)_ | Path to PotreeConverter binary |

---

## License

MIT — use it, modify it, ship it.
