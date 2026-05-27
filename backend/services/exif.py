"""EXIF/GPS metadata extraction from aerial images.

Phase 3 additions:
  • Richer RTK fix detection — checks XMP:RtkFlag, XMP:RtkStdLon/Lat/Hgt,
    GPS DOP thresholds, and DJI-specific tags.
  • Horizontal / vertical accuracy estimation from RTK std tags.
  • Summarize returns rtk_accuracy_h, rtk_accuracy_v estimates.
"""

from pathlib import Path
from typing import Optional
import exifread


# ─── DMS helper ───────────────────────────────────────────────────────────────

def dms_to_decimal(values, ref: str) -> float:
    """Convert GPS DMS (degrees, minutes, seconds) to decimal degrees."""
    d = float(values[0].num) / float(values[0].den)
    m = float(values[1].num) / float(values[1].den)
    s = float(values[2].num) / float(values[2].den)
    decimal = d + m / 60.0 + s / 3600.0
    if ref in ("S", "W"):
        decimal = -decimal
    return decimal


# ─── RTK quality classifier ───────────────────────────────────────────────────

# Maps DOP range → RTK quality label
_DOP_BANDS = [
    (1.0,  "RTK Fix",    True),
    (2.0,  "RTK Float",  True),
    (5.0,  "DGPS",       False),
    (10.0, "GPS",        False),
]


def _classify_dop(dop: float) -> tuple[str, bool]:
    for threshold, label, is_rtk in _DOP_BANDS:
        if dop <= threshold:
            return label, is_rtk
    return "Poor GPS", False


# ─── Single image extractor ────────────────────────────────────────────────────

def extract_exif(image_path: Path) -> dict:
    """Extract GPS coordinates, camera info, and RTK quality from a single image."""
    result = {
        "filename":     image_path.name,
        "latitude":     None,
        "longitude":    None,
        "altitude":     None,
        "timestamp":    None,
        "make":         None,
        "model":        None,
        "width":        None,
        "height":       None,
        "rtk_fix":      False,
        "rtk_quality":  "Unknown",   # "RTK Fix", "RTK Float", "DGPS", "GPS", "Poor GPS"
        "acc_h":        None,        # Estimated horizontal accuracy (m)
        "acc_v":        None,        # Estimated vertical accuracy (m)
        "dop":          None,
    }

    try:
        with open(image_path, "rb") as f:
            tags = exifread.process_file(f, details=False)

        # ── GPS coordinates ──────────────────────────────────────────────────
        if "GPS GPSLatitude" in tags and "GPS GPSLatitudeRef" in tags:
            result["latitude"] = dms_to_decimal(
                tags["GPS GPSLatitude"].values,
                str(tags["GPS GPSLatitudeRef"]),
            )

        if "GPS GPSLongitude" in tags and "GPS GPSLongitudeRef" in tags:
            result["longitude"] = dms_to_decimal(
                tags["GPS GPSLongitude"].values,
                str(tags["GPS GPSLongitudeRef"]),
            )

        if "GPS GPSAltitude" in tags:
            alt = tags["GPS GPSAltitude"].values[0]
            result["altitude"] = float(alt.num) / float(alt.den)

        # ── Timestamp ────────────────────────────────────────────────────────
        if "EXIF DateTimeOriginal" in tags:
            result["timestamp"] = str(tags["EXIF DateTimeOriginal"])

        # ── Camera info ──────────────────────────────────────────────────────
        if "Image Make" in tags:
            result["make"] = str(tags["Image Make"]).strip()
        if "Image Model" in tags:
            result["model"] = str(tags["Image Model"]).strip()

        # ── Image dimensions ─────────────────────────────────────────────────
        if "EXIF ExifImageWidth" in tags:
            result["width"] = int(str(tags["EXIF ExifImageWidth"]))
        if "EXIF ExifImageLength" in tags:
            result["height"] = int(str(tags["EXIF ExifImageLength"]))

        # ── RTK detection ────────────────────────────────────────────────────
        # Priority 1: XMP RtkFlag (DJI Phantom 4 RTK / Matrice RTK)
        #   0 = no fix, 1 = float, 2 = fix
        if "XMP RtkFlag" in tags:
            flag = int(str(tags["XMP RtkFlag"]))
            if flag == 2:
                result["rtk_quality"] = "RTK Fix"
                result["rtk_fix"] = True
            elif flag == 1:
                result["rtk_quality"] = "RTK Float"
                result["rtk_fix"] = True  # still good enough for survey
            else:
                result["rtk_quality"] = "GPS"

        # Priority 2: XMP std deviation tags (DJI stores in cm, need → m)
        for tag_h, tag_v in [
            ("XMP RtkStdLon", "XMP RtkStdHgt"),
            ("XMP AbsoluteAltitudeAccuracy", "XMP RelativeAltitudeAccuracy"),
        ]:
            if tag_h in tags and tag_v in tags:
                try:
                    ah = abs(float(str(tags[tag_h])))
                    av = abs(float(str(tags[tag_v])))
                    # Convert cm → m if values look like centimeters
                    if ah > 1.0:
                        ah /= 100.0
                    if av > 1.0:
                        av /= 100.0
                    result["acc_h"] = round(ah, 4)
                    result["acc_v"] = round(av, 4)
                    if not result["rtk_fix"]:
                        result["rtk_fix"] = ah < 0.05
                except Exception:
                    pass
                break

        # Priority 3: GPS DOP (all cameras)
        if "GPS GPSDOP" in tags:
            dop = tags["GPS GPSDOP"].values[0]
            dop_val = float(dop.num) / float(dop.den)
            result["dop"] = round(dop_val, 2)
            quality, is_rtk = _classify_dop(dop_val)
            # Only override if not already set by XMP
            if result["rtk_quality"] == "Unknown":
                result["rtk_quality"] = quality
                result["rtk_fix"] = is_rtk
            # Estimate accuracy from DOP if not already known
            if result["acc_h"] is None:
                # Rough: ±3m per DOP unit at PDOP baseline of 1m
                result["acc_h"] = round(dop_val * 3.0, 2)
                result["acc_v"] = round(dop_val * 4.5, 2)

    except Exception:
        pass  # Return partial results on failure

    return result


# ─── Dataset summariser ────────────────────────────────────────────────────────

def summarize_dataset(image_paths: list[Path]) -> dict:
    """Sample EXIF from a dataset and return a high-level summary."""
    sample_size = min(30, len(image_paths))
    sample = image_paths[:sample_size]

    coords = []
    has_gps = 0
    rtk_fix_count = 0
    rtk_float_count = 0
    makes: set[str] = set()
    acc_h_vals: list[float] = []
    acc_v_vals: list[float] = []
    qualities: dict[str, int] = {}

    for p in sample:
        info = extract_exif(p)
        if info["latitude"] is not None and info["longitude"] is not None:
            has_gps += 1
            coords.append((info["latitude"], info["longitude"]))
        q = info["rtk_quality"]
        qualities[q] = qualities.get(q, 0) + 1
        if q == "RTK Fix":
            rtk_fix_count += 1
        elif q == "RTK Float":
            rtk_float_count += 1
        if info["make"]:
            makes.add(info["make"])
        if info["acc_h"] is not None:
            acc_h_vals.append(info["acc_h"])
        if info["acc_v"] is not None:
            acc_v_vals.append(info["acc_v"])

    bbox = None
    if coords:
        lats = [c[0] for c in coords]
        lons = [c[1] for c in coords]
        bbox = {
            "min_lat": min(lats), "max_lat": max(lats),
            "min_lon": min(lons), "max_lon": max(lons),
        }

    avg_acc_h = round(sum(acc_h_vals) / len(acc_h_vals), 3) if acc_h_vals else None
    avg_acc_v = round(sum(acc_v_vals) / len(acc_v_vals), 3) if acc_v_vals else None

    return {
        "total_images": len(image_paths),
        "has_gps_pct":  round(has_gps / sample_size * 100, 1) if sample_size else 0,
        "rtk_fix_pct":  round(rtk_fix_count / sample_size * 100, 1) if sample_size else 0,
        "rtk_float_pct": round(rtk_float_count / sample_size * 100, 1) if sample_size else 0,
        "camera_makes": list(makes),
        "bbox": bbox,
        "qualities": qualities,
        "avg_acc_h": avg_acc_h,   # metres
        "avg_acc_v": avg_acc_v,   # metres
    }
