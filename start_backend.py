"""
PhotoForge Backend Launcher
Starts all required services: Redis, Celery worker, FastAPI server,
and the frontend UI on http://localhost:1420.
"""

import subprocess
import sys
import time
import threading
import os
import webbrowser
from pathlib import Path
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

# Force UTF-8 so emoji print correctly on Windows
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

ROOT      = Path(__file__).parent
DIST_DIR  = ROOT / "frontend" / "dist"
UI_PORT   = 1420


# ── SPA HTTP server ───────────────────────────────────────────────────────────

class SPAHandler(SimpleHTTPRequestHandler):
    """Serve static files; fall back to index.html for SPA routes."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(DIST_DIR), **kwargs)

    def do_GET(self):
        # If the requested path maps to a real file, serve it normally
        fs_path = DIST_DIR / self.path.lstrip("/")
        if fs_path.exists() and fs_path.is_file():
            super().do_GET()
        else:
            # SPA fallback — serve index.html for all unknown routes
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            index = (DIST_DIR / "index.html").read_bytes()
            self.send_header("Content-Length", str(len(index)))
            self.end_headers()
            self.wfile.write(index)

    def log_message(self, *args):
        pass  # suppress request logs


def start_ui_server():
    if not DIST_DIR.exists():
        print("⚠   Frontend dist not found — UI will not be available.")
        print("    Build it with: cd frontend && npm run build")
        return
    server = ThreadingHTTPServer(("0.0.0.0", UI_PORT), SPAHandler)
    print(f"✅  PhotoForge UI at http://localhost:{UI_PORT}")
    server.serve_forever()


# ── Helpers ───────────────────────────────────────────────────────────────────

def run(cmd, **kwargs):
    print(f"  → {' '.join(cmd)}")
    return subprocess.Popen(cmd, cwd=ROOT, **kwargs)


def check_port(port: int, timeout=30) -> bool:
    import socket
    for _ in range(timeout * 2):
        try:
            with socket.create_connection(("localhost", port), timeout=0.5):
                return True
        except OSError:
            time.sleep(0.5)
    return False


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    print("=" * 60)
    print("  PhotoForge Launcher")
    print("=" * 60)

    # Check Docker
    try:
        subprocess.run(["docker", "info"], capture_output=True, check=True)
    except (subprocess.CalledProcessError, FileNotFoundError):
        print("\n❌  Docker is not running or not installed.")
        print("    Install Docker Desktop from https://docker.com")
        sys.exit(1)

    print("\n🐳  Starting services with Docker Compose…")
    compose = run(["docker", "compose", "up", "-d"])
    compose.wait()

    print("\n⏳  Waiting for FastAPI to be ready on port 8000…")
    if check_port(8000):
        print("✅  Backend is ready at http://localhost:8000")
    else:
        print("⚠   Backend didn't start in time — check `docker compose logs`")
        sys.exit(1)

    print("\n⏳  Waiting for NodeODM on port 3000…")
    if check_port(3000):
        print("✅  NodeODM ready at http://localhost:3000")
    else:
        print("⚠   NodeODM not available — processing will fail until it starts")

    # Start UI server in background thread
    print(f"\n🖥   Starting PhotoForge UI on port {UI_PORT}…")
    ui_thread = threading.Thread(target=start_ui_server, daemon=True)
    ui_thread.start()
    time.sleep(1)

    print("\n🚀  All services running!")
    print(f"    PhotoForge UI:  http://localhost:{UI_PORT}")
    print( "    API docs:       http://localhost:8000/docs")
    print( "    NodeODM:        http://localhost:3000")
    print("\n    Opening browser…")
    webbrowser.open(f"http://localhost:{UI_PORT}")
    print("\n    Press Ctrl+C to stop all services.\n")

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n🛑  Stopping services…")
        subprocess.run(["docker", "compose", "down"], cwd=ROOT)
        print("✅  Stopped.")


if __name__ == "__main__":
    main()
