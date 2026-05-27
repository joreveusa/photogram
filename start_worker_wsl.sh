#!/bin/bash
set -e

WIN_IP=$(cat /etc/resolv.conf | grep nameserver | awk '{print $2}')
echo "Windows host IP: $WIN_IP"

# Start NodeODM standalone (no volumes — prevents crash loops)
docker rm -f photoforge_nodeodm 2>/dev/null || true
docker run -d --name photoforge_nodeodm \
  -p 3000:3000 \
  --restart unless-stopped \
  opendronemap/nodeodm:latest

echo "Waiting 10s for NodeODM to start..."
sleep 10

echo "NodeODM check:"
curl -sf http://localhost:3000/info | python3 -c 'import json,sys; d=json.load(sys.stdin); print("  v" + d["version"], "- tasks:", d["taskQueueCount"])' || echo "  NOT READY"

echo "Redis check:"
python3 -c "import redis; r=redis.Redis(host='${WIN_IP}'); print('  ping:', r.ping())" || echo "  NOT READY"

export REDIS_URL="redis://${WIN_IP}:6379/0"
export NODEODM_URL="http://localhost:3000"
export OUTPUT_DIR="/mnt/s/Photogram/outputs"
export DATABASE_URL="sqlite:////mnt/s/Photogram/outputs/photoforge.db"

echo ""
echo "Starting Celery worker..."
cd /mnt/s/Photogram/backend
python3 -m celery -A celery_app worker --loglevel=info --pool=solo
