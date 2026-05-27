#!/bin/bash
echo "=== tasks.json ==="
docker exec photoforge_nodeodm cat /var/www/data/tasks.json

echo ""
echo "=== NodeODM app log ==="
docker exec photoforge_nodeodm cat /var/www/node-OpenDroneMap.log 2>/dev/null | tail -30

echo ""
echo "=== /tmp dir inside container ==="
docker exec photoforge_nodeodm ls -la /var/www/tmp/ 2>/dev/null | head -10

echo ""
echo "=== Create task and check everything ==="
UUID=$(curl -s -X POST http://localhost:3000/task/new/init | python3 -c 'import json,sys; print(json.load(sys.stdin)["uuid"])')
echo "UUID: $UUID"
sleep 1
echo "tasks.json after create:"
docker exec photoforge_nodeodm cat /var/www/data/tasks.json
echo "data dir:"
docker exec photoforge_nodeodm ls /var/www/data/
echo "tmp dir (multer staging):"
docker exec photoforge_nodeodm ls -la /var/www/tmp/ 2>/dev/null

echo ""
echo "=== NodeODM config ==="
docker exec photoforge_nodeodm cat /var/www/config-default.json
