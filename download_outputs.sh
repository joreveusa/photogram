#!/bin/bash
# Download all outputs from NodeODM to Windows filesystem
TASK_UUID="6e8cdd29-e3b0-4e24-a244-679f9c53e3f0"
JOB_ID="d934507a-4b97-4b77-91c3-eea5f3d08270"
OUT_DIR="/mnt/s/Photogram/outputs/${JOB_ID}"
mkdir -p "$OUT_DIR"

BASE="http://localhost:3000"

download() {
    local asset="$1"
    local dest="$2"
    echo -n "Downloading $dest ... "
    mkdir -p "$(dirname $dest)"
    HTTP=$(curl -sf -w "%{http_code}" -o "$dest" "${BASE}/task/${TASK_UUID}/download/${asset}" 2>/dev/null)
    if [ "$HTTP" = "200" ] && [ -s "$dest" ]; then
        SIZE=$(du -h "$dest" | cut -f1)
        echo "OK ($SIZE)"
    else
        echo "SKIP (HTTP $HTTP)"
        rm -f "$dest"
    fi
}

echo "=== Downloading ODM outputs ==="
download "odm_orthophoto/odm_orthophoto.tif"               "$OUT_DIR/orthomosaic.tif"
download "odm_georeferencing/odm_georeferenced_model.laz"  "$OUT_DIR/point_cloud.laz"
download "odm_texturing_25d/odm_textured_model_geo.obj"    "$OUT_DIR/mesh.obj"
download "odm_dem/dsm.tif"                                 "$OUT_DIR/dsm.tif"
download "odm_report/report.pdf"                           "$OUT_DIR/report.pdf"
download "all.zip"                                         "$OUT_DIR/all.zip"

echo ""
echo "=== Final output listing ==="
ls -lh "$OUT_DIR"
