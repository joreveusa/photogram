"""
PhotoForge Backend Launcher
Starts all required services: Redis, Celery worker, FastAPI server.
Run this script before launching the PhotoForge desktop app.
"""

import subprocess
import sys
import time
import os
import webbrowser
from pathlib import Path

ROOT = Path(__file__).parent

def run(cmd, **kwargs):
    print(f"  → {' '.join(cmd)}")
    return subprocess.Popen(cmd, cwd=ROOT, **kwargs)

def check_port(port: int, timeout=30) -> bool:
    """Wait for a port to be listening."""
    import socket
    for _ in range(timeout * 2):
        try:
            with socket.create_connection(("localhost", port), timeout=0.5):
                return True
        except OSError:
            time.sleep(0.5)
    return False

def main():
    print("=" * 60)
    print("  PhotoForge Backend Launcher")
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

    print("\n🚀  All services running!")
    print("    API docs:  http://localhost:8000/docs")
    print("    NodeODM:   http://localhost:3000")
    print("\n    You can now launch PhotoForge.exe\n")
    print("    Press Ctrl+C to stop all services.\n")

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n🛑  Stopping services…")
        subprocess.run(["docker", "compose", "down"], cwd=ROOT)
        print("✅  Stopped.")

if __name__ == "__main__":
    main()
