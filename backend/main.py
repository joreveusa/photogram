"""FastAPI application entrypoint for PhotoForge backend."""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager

from database import init_db
from routers import projects, jobs, system


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize the database on startup."""
    init_db()
    yield


app = FastAPI(
    title="PhotoForge API",
    description="Local-first photogrammetry processing backend",
    version="0.1.0",
    lifespan=lifespan,
)

# Allow Tauri webview and local dev server
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:1420",   # Tauri dev
        "http://localhost:5173",   # Vite dev
        "http://localhost:3001",   # Alt dev
        "tauri://localhost",       # Tauri production
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(projects.router)
app.include_router(jobs.router)
app.include_router(system.router)


@app.get("/health")
def health():
    return {"status": "ok", "service": "PhotoForge API"}
