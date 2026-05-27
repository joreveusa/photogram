#!/bin/bash
echo "=== Create task ==="
RESP=$(curl -s -X POST http://localhost:3000/task/new/init)
echo "Response: $RESP"
UUID=$(echo "$RESP" | python3 -c 'import json,sys; print(json.load(sys.stdin)["uuid"])')
echo "UUID: $UUID"

echo ""
echo "=== Upload attempt - verbose response ==="
dd if=/dev/urandom bs=1k count=100 of=/tmp/test.jpg 2>/dev/null
UPLOAD_RESP=$(curl -s -w "\nHTTP_STATUS:%{http_code}" -X POST "http://localhost:3000/task/${UUID}/upload" \
    -F "images=@/tmp/test.jpg;filename=test.JPG")
echo "$UPLOAD_RESP"

echo ""
echo "=== Task info ==="
curl -s "http://localhost:3000/task/${UUID}/info"
