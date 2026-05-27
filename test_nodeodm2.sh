#!/bin/bash
echo "=== Check container disk space ==="
docker exec photoforge_nodeodm df -h /var/www/data 2>/dev/null || echo "exec failed"

echo "=== Create task ==="
UUID=$(curl -sf -X POST http://localhost:3000/task/new/init | python3 -c 'import json,sys; print(json.load(sys.stdin)["uuid"])')
echo "UUID: $UUID"

echo "=== Upload fake 5MB JPEG from /tmp (NOT Windows FS) ==="
dd if=/dev/urandom bs=1k count=5000 of=/tmp/fake.jpg 2>/dev/null
curl -sf -X POST "http://localhost:3000/task/${UUID}/upload" \
    -F "images=@/tmp/fake.jpg;filename=fake.JPG" && echo "FAKE upload OK" || echo "FAKE upload FAILED"

echo "=== NodeODM after fake upload ==="
curl -sf http://localhost:3000/info | python3 -c 'import json,sys; d=json.load(sys.stdin); print("UP v" + d["version"])' || echo "DOWN"

echo "=== Now copy real JPEG to /tmp and upload from there ==="
UUID2=$(curl -sf -X POST http://localhost:3000/task/new/init | python3 -c 'import json,sys; print(json.load(sys.stdin)["uuid"])')
SRCFILE="/mnt/s/Photogram/outputs/staging/c45a954a-cd02-4c1d-b052-1988e96a8d2e/DSC00229.JPG"
cp "$SRCFILE" /tmp/real.JPG
echo "Copied $(du -h /tmp/real.JPG | cut -f1) from Windows FS to /tmp"
curl -sf -X POST "http://localhost:3000/task/${UUID2}/upload" \
    -F "images=@/tmp/real.JPG;filename=real.JPG" && echo "REAL upload OK" || echo "REAL upload FAILED"

echo "=== NodeODM after real upload ==="
curl -sf http://localhost:3000/info | python3 -c 'import json,sys; d=json.load(sys.stdin); print("UP v" + d["version"])' || echo "DOWN"
