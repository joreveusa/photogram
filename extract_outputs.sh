#!/bin/bash
OUT="/mnt/s/Photogram/outputs/d934507a-4b97-4b77-91c3-eea5f3d08270"
mkdir -p "$OUT/extracted"

echo "=== Installing unzip ==="
apt-get install -y -qq unzip 2>/dev/null

echo "=== Extracting all.zip ==="
cd "$OUT/extracted"
unzip -o "$OUT/all.zip" 2>&1 | grep -E "inflating|creating|Archive" | head -30

echo ""
echo "=== All extracted files ==="
find "$OUT/extracted" -type f | sort | while read f; do
    size=$(stat -c%s "$f")
    mb=$(echo "scale=1; $size / 1048576" | bc)
    echo "${mb}MB  ${f#$OUT/extracted/}"
done

echo ""
echo "=== Copying key files to outputs root ==="
# Copy the main deliverables
cp "$OUT/extracted/odm_orthophoto/odm_orthophoto.tif" "$OUT/orthomosaic.tif" 2>/dev/null && echo "orthomosaic.tif OK" || echo "orthomosaic.tif: not found"
cp "$OUT/extracted/odm_georeferencing/odm_georeferenced_model.laz" "$OUT/point_cloud.laz" 2>/dev/null && echo "point_cloud.laz OK" || echo "point_cloud.laz: not found"
cp "$OUT/extracted/odm_dem/dsm.tif" "$OUT/dsm.tif" 2>/dev/null && echo "dsm.tif OK" || echo "dsm.tif: not found"
cp "$OUT/extracted/odm_report/report.pdf" "$OUT/report.pdf" 2>/dev/null && echo "report.pdf OK" || echo "report.pdf: not found"

echo ""
echo "=== Final outputs ==="
ls -lh "$OUT"/*.tif "$OUT"/*.laz "$OUT"/*.pdf "$OUT"/*.zip 2>/dev/null
