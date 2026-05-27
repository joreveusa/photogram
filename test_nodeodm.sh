#!/bin/bash
echo "=== Create task ==="
UUID=$(curl -sf -X POST http://localhost:3000/task/new/init | python3 -c 'import json,sys; print(json.load(sys.stdin)["uuid"])')
echo "UUID: $UUID"
sleep 2

echo "=== NodeODM still up after create? ==="
curl -sf http://localhost:3000/info | python3 -c 'import json,sys; d=json.load(sys.stdin); print("UP - tasks:", d["taskQueueCount"])' || echo "DOWN"

echo "=== Upload 1 real JPEG ==="
IMGFILE=$(ls /mnt/s/Photogram/outputs/staging/c45a954a-cd02-4c1d-b052-1988e96a8d2e/*.JPG 2>/dev/null | head -1)
if [ -z "$IMGFILE" ]; then
    IMGFILE=$(ls /mnt/s/Photogram/sample_data/odm_data_aukerman-master/images/*.JPG 2>/dev/null | head -1)
fi
echo "Image: $IMGFILE"
curl -sf -X POST "http://localhost:3000/task/${UUID}/upload" \
    -F "images=@${IMGFILE};filename=test.JPG" && echo "upload OK" || echo "upload FAILED - HTTP error"

echo "=== NodeODM after upload ==="
curl -sf http://localhost:3000/info | python3 -c 'import json,sys; d=json.load(sys.stdin); print("UP - tasks:", d["taskQueueCount"])' || echo "DOWN"

echo "=== Container log tail ==="
docker logs photoforge_nodeodm 2>&1 | grep -E "info:|Error|error" | tail -8
