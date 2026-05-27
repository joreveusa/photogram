#!/bin/bash
# Full Ubuntu WSL2 reinstall setup script
# Run this AFTER: wsl --unregister Ubuntu && wsl --install -d Ubuntu
# (Ubuntu installs to default location, user "root" can run this)

set -e
echo "=== PhotoForge WSL2 Setup ==="

# 1. Update apt
apt-get update -qq

# 2. Install Python deps
echo "Installing Python packages..."
apt-get install -y -qq python3 python3-pip python3-venv curl wget unzip

# 3. Install Celery + pipeline deps
pip3 install --break-system-packages \
    celery redis requests sqlmodel sqlalchemy \
    fastapi uvicorn python-multipart aiofiles python-dotenv

# 4. Install Docker
echo "Installing Docker..."
curl -fsSL https://get.docker.com | sh
systemctl enable docker 2>/dev/null || true

# 5. Pull NodeODM
echo "Pulling NodeODM Docker image (this takes a few minutes)..."
docker pull opendronemap/nodeodm:latest

# 6. Start NodeODM
docker rm -f photoforge_nodeodm 2>/dev/null || true
docker run -d --name photoforge_nodeodm \
    -p 3000:3000 \
    --restart unless-stopped \
    opendronemap/nodeodm:latest

echo ""
echo "=== Setup complete! Testing... ==="
sleep 5
curl -sf http://localhost:3000/info | python3 -c \
    'import json,sys; d=json.load(sys.stdin); print("NodeODM v"+d["version"]+" OK")'

echo ""
echo "Now run: bash /mnt/s/Photogram/start_worker_wsl.sh"
