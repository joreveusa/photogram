#!/bin/bash
WIN_IP=$(cat /etc/resolv.conf | grep nameserver | awk '{print $2}')
echo "Windows host IP: $WIN_IP"

echo "--- NodeODM test ---"
curl -s http://localhost:3000/info | python3 -c 'import json,sys; d=json.load(sys.stdin); print("NodeODM:", d["version"])'

echo "--- Redis test ---"
python3 -c "import redis; r=redis.Redis(host='$WIN_IP', port=6379); print('Redis ping:', r.ping())"

echo "--- requests test ---"
python3 -c "import requests; r=requests.get('http://localhost:3000/info',timeout=5); print('requests OK:', r.json()['version'])"
