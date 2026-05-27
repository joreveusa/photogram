"""GCP Target Auto-Detection Service.

Strategies (selectable per-run):
  • triangle_cross — Pinwheel/bowtie B&W panel (4 alternating triangles) — DEFAULT
                     This is the standard Red Tail Surveying GCP target.
  • spray_paint    — Spray-painted X/cross on ground (pink, orange, yellow, blue, red)
                     Detected by HSV color segmentation + skeleton line intersection.
  • checkerboard  — Classic B&W checker panel (OpenCV findChessboardCorners)
  • aruco         — Coded ArUco markers (opencv-contrib)
  • circle_grid   — Symmetric/asymmetric dot-grid panels
  • template      — User-supplied reference image (normalized cross-correlation)
  • blob          — High-contrast blob (orange panels, large painted targets)

Pipeline per GCP:
  1. GPS pre-filter  → keep only images taken within `radius_m` of the GCP
  2. Run detector    → find target pixel coordinates in each candidate
  3. Return ranked DetectionResult list (highest confidence first)
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Optional

from loguru import logger

# ── lazy CV import so the service loads even if opencv isn't installed yet ─────

def _cv2():
    try:
        import cv2
        return cv2
    except ImportError as exc:
        raise RuntimeError(
            "opencv-contrib-python is required for GCP auto-detection. "
            "Run: pip install opencv-contrib-python"
        ) from exc

def _np():
    import numpy as np
    return np


# ─── Result dataclass ──────────────────────────────────────────────────────────

@dataclass
class DetectionResult:
    gcp_label: str
    image_name: str
    pixel_x: float
    pixel_y: float
    confidence: float          # 0–1, higher = better
    strategy: str
    candidates_scanned: int = 0
    elapsed_s: float = 0.0
    extra: dict = field(default_factory=dict)   # e.g. marker_id, corners

    def to_dict(self) -> dict:
        return asdict(self)


# ─── GPS pre-filter ────────────────────────────────────────────────────────────

_EARTH_R_M = 6_371_000.0


def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Approximate ground distance in metres between two lat/lon pairs."""
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(math.radians(lat1))
        * math.cos(math.radians(lat2))
        * math.sin(dlon / 2) ** 2
    )
    return _EARTH_R_M * 2 * math.asin(math.sqrt(a))


def filter_images_near_gcp(
    image_meta: list[dict],   # list of {filename, latitude, longitude}
    gcp_lat: float,
    gcp_lon: float,
    radius_m: float = 80.0,
) -> list[dict]:
    """Return image metadata records within `radius_m` metres of the GCP."""
    nearby = []
    for img in image_meta:
        lat = img.get("latitude")
        lon = img.get("longitude")
        if lat is None or lon is None:
            continue
        dist = _haversine_m(lat, lon, gcp_lat, gcp_lon)
        if dist <= radius_m:
            nearby.append({**img, "_dist_m": round(dist, 1)})
    # Sort closest first — better images more likely to contain the target clearly
    nearby.sort(key=lambda x: x["_dist_m"])
    return nearby


# ─── Individual detectors ─────────────────────────────────────────────────────

def _load_gray(image_path: Path):
    """Load image as grayscale numpy array."""
    cv2 = _cv2()
    img = cv2.imread(str(image_path))
    if img is None:
        raise FileNotFoundError(f"Cannot load image: {image_path}")
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    return img, gray


def detect_checkerboard(
    image_path: Path,
    pattern_size: tuple[int, int] = (4, 4),
) -> Optional[tuple[float, float, float]]:
    """
    Detect a checkerboard pattern and return (cx, cy, confidence).
    pattern_size: (cols, rows) of *inner* corners.
    """
    cv2 = _cv2()
    np = _np()

    img, gray = _load_gray(image_path)

    flags = (
        cv2.CALIB_CB_ADAPTIVE_THRESH
        | cv2.CALIB_CB_NORMALIZE_IMAGE
        | cv2.CALIB_CB_FAST_CHECK
    )
    found, corners = cv2.findChessboardCorners(gray, pattern_size, flags)

    if not found:
        # Try a downscaled version for large images
        h, w = gray.shape
        if max(h, w) > 3000:
            scale = 3000 / max(h, w)
            small = cv2.resize(gray, (int(w * scale), int(h * scale)))
            found, corners = cv2.findChessboardCorners(small, pattern_size, flags)
            if found and corners is not None:
                corners = corners / scale

    if not found or corners is None:
        return None

    # Sub-pixel refine
    criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 0.001)
    corners = cv2.cornerSubPix(gray, corners, (11, 11), (-1, -1), criteria)

    cx = float(np.mean(corners[:, 0, 0]))
    cy = float(np.mean(corners[:, 0, 1]))
    # Confidence: corner count ratio vs expected
    confidence = min(1.0, len(corners) / (pattern_size[0] * pattern_size[1]))
    return cx, cy, confidence


def detect_aruco(
    image_path: Path,
    aruco_dict_id: int = 0,   # cv2.aruco.DICT_4X4_50
    target_marker_id: Optional[int] = None,
) -> Optional[tuple[float, float, float, int]]:
    """
    Detect ArUco marker and return (cx, cy, confidence, marker_id).
    If target_marker_id is None, returns the first/largest detected marker.
    aruco_dict_id: integer constant from cv2.aruco dict IDs.
    """
    cv2 = _cv2()
    np = _np()

    img, gray = _load_gray(image_path)

    try:
        aruco = cv2.aruco
        aruco_dict = aruco.getPredefinedDictionary(aruco_dict_id)
        params = aruco.DetectorParameters()
        detector = aruco.ArucoDetector(aruco_dict, params)
        corners_list, ids, _ = detector.detectMarkers(gray)
    except AttributeError:
        # Older opencv-contrib API
        try:
            aruco = cv2.aruco
            aruco_dict = aruco.Dictionary_get(aruco_dict_id)
            params = aruco.DetectorParameters_create()
            corners_list, ids, _ = aruco.detectMarkers(gray, aruco_dict, parameters=params)
        except Exception as exc:
            logger.warning(f"ArUco detection failed on {image_path.name}: {exc}")
            return None

    if ids is None or len(ids) == 0:
        return None

    # Pick marker
    chosen_idx = 0
    if target_marker_id is not None:
        flat_ids = ids.flatten()
        matches = np.where(flat_ids == target_marker_id)[0]
        if len(matches) == 0:
            return None
        chosen_idx = matches[0]

    marker_id = int(ids[chosen_idx][0])
    c = corners_list[chosen_idx][0]   # shape (4, 2)
    cx = float(np.mean(c[:, 0]))
    cy = float(np.mean(c[:, 1]))
    return cx, cy, 0.95, marker_id   # ArUco finds are very reliable


def detect_circle_grid(
    image_path: Path,
    pattern_size: tuple[int, int] = (4, 4),
    asymmetric: bool = False,
) -> Optional[tuple[float, float, float]]:
    """Detect a symmetric or asymmetric circle grid."""
    cv2 = _cv2()
    np = _np()

    img, gray = _load_gray(image_path)

    flags = cv2.CALIB_CB_ASYMMETRIC_GRID if asymmetric else cv2.CALIB_CB_SYMMETRIC_GRID
    found, centers = cv2.findCirclesGrid(gray, pattern_size, flags=flags)

    if not found or centers is None:
        return None

    cx = float(np.mean(centers[:, 0, 0]))
    cy = float(np.mean(centers[:, 0, 1]))
    confidence = min(1.0, len(centers) / (pattern_size[0] * pattern_size[1]))
    return cx, cy, confidence


def detect_template(
    image_path: Path,
    template_path: Path,
    threshold: float = 0.6,
) -> Optional[tuple[float, float, float]]:
    """
    Normalized cross-correlation template match.
    Returns centroid of best match location if score ≥ threshold.
    """
    cv2 = _cv2()

    img, gray = _load_gray(image_path)
    tmpl_img, tmpl_gray = _load_gray(template_path)

    th, tw = tmpl_gray.shape[:2]

    # Multi-scale matching (0.5× – 2.0× template size)
    best_val = -1.0
    best_loc = (0, 0)
    best_scale = 1.0

    for scale in [0.5, 0.75, 1.0, 1.25, 1.5, 2.0]:
        new_w = max(8, int(tw * scale))
        new_h = max(8, int(th * scale))
        if new_w > gray.shape[1] or new_h > gray.shape[0]:
            continue
        scaled_tmpl = cv2.resize(tmpl_gray, (new_w, new_h))
        result = cv2.matchTemplate(gray, scaled_tmpl, cv2.TM_CCOEFF_NORMED)
        _, max_val, _, max_loc = cv2.minMaxLoc(result)
        if max_val > best_val:
            best_val = max_val
            best_loc = max_loc
            best_scale = scale

    if best_val < threshold:
        return None

    # Centroid of matched region
    scaled_w = int(tw * best_scale)
    scaled_h = int(th * best_scale)
    cx = float(best_loc[0] + scaled_w / 2)
    cy = float(best_loc[1] + scaled_h / 2)
    return cx, cy, float(best_val)


def detect_blob(
    image_path: Path,
    min_area: float = 500.0,
    max_area: float = 50000.0,
    min_circularity: float = 0.5,
) -> Optional[tuple[float, float, float]]:
    """
    Blob detector — finds large, high-contrast regions (painted panels, etc.).
    Returns the centroid of the largest qualifying blob.
    """
    cv2 = _cv2()
    np = _np()

    img, gray = _load_gray(image_path)

    params = cv2.SimpleBlobDetector_Params()
    params.filterByArea = True
    params.minArea = min_area
    params.maxArea = max_area
    params.filterByCircularity = True
    params.minCircularity = min_circularity
    params.filterByConvexity = False
    params.filterByInertia = False

    detector = cv2.SimpleBlobDetector_create(params)
    keypoints = detector.detect(gray)

    if not keypoints:
        return None

    # Largest blob by size
    best = max(keypoints, key=lambda k: k.size)
    confidence = min(1.0, best.size / 200.0)   # normalise — 200px diameter → 1.0
    return float(best.pt[0]), float(best.pt[1]), confidence


def detect_triangle_cross(
    image_path: Path,
    min_panel_area_px: int = 400,
    max_panel_area_px: int = 500_000,
) -> Optional[tuple[float, float, float]]:
    """
    Detect a pinwheel / triangle-cross GCP target:
    a square panel divided into 4 alternating black-and-white triangles
    (2 black triangles top+bottom, 2 white triangles left+right, or vice-versa).
    The GCP mark is the exact centre where all 4 triangles meet.

    Algorithm:
      1. Adaptive threshold → binary mask
      2. Find large square-ish white contours (the panel bounding box)
      3. Within the best candidate ROI, locate the intersection of the
         two diagonal lines that divide the triangles using line detection
         (HoughLinesP on Canny edges inside the ROI).
      4. If line intersection is found, refine with cornerSubPix.
      5. Confidence = f(squareness, contrast ratio, line count)
    """
    cv2 = _cv2()
    np = _np()

    img, gray = _load_gray(image_path)
    h, w = gray.shape

    # ── Step 1: Adaptive threshold to handle varying lighting ─────────────────
    blur = cv2.GaussianBlur(gray, (5, 5), 0)
    thresh = cv2.adaptiveThreshold(
        blur, 255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY, 51, 5
    )

    # ── Step 2: Find large contours that could be the panel ───────────────────
    contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    best_score = -1.0
    best_center = None

    for cnt in contours:
        area = cv2.contourArea(cnt)
        if area < min_panel_area_px or area > max_panel_area_px:
            continue

        # Approximate as polygon
        peri = cv2.arcLength(cnt, True)
        approx = cv2.approxPolyDP(cnt, 0.04 * peri, True)

        # Must be roughly quadrilateral (4–6 vertices for a slightly tilted square)
        if len(approx) < 4 or len(approx) > 8:
            continue

        x, y, bw, bh = cv2.boundingRect(cnt)

        # Squareness check — panel should be roughly square
        aspect = bw / bh if bh > 0 else 0
        if aspect < 0.5 or aspect > 2.0:
            continue

        # ── Step 3: Detect diagonal lines inside the ROI ──────────────────────
        margin = max(4, int(min(bw, bh) * 0.05))
        rx, ry = max(0, x - margin), max(0, y - margin)
        rw = min(w - rx, bw + 2 * margin)
        rh = min(h - ry, bh + 2 * margin)
        roi = gray[ry:ry + rh, rx:rx + rw]

        if roi.size == 0:
            continue

        edges = cv2.Canny(roi, 50, 150, apertureSize=3)
        lines = cv2.HoughLinesP(
            edges, 1, np.pi / 180,
            threshold=int(min(rw, rh) * 0.3),
            minLineLength=int(min(rw, rh) * 0.3),
            maxLineGap=int(min(rw, rh) * 0.15),
        )

        # Find intersection of detected lines (centre of X)
        cx_roi, cy_roi = rw / 2, rh / 2  # fallback: geometric centre
        line_confidence = 0.3

        if lines is not None and len(lines) >= 2:
            # Collect all line intersection points
            intersections = []
            for i in range(len(lines)):
                for j in range(i + 1, len(lines)):
                    pt = _line_intersection(lines[i][0], lines[j][0])
                    if pt is not None:
                        px, py = pt
                        if 0 <= px <= rw and 0 <= py <= rh:
                            intersections.append((px, py))

            if intersections:
                # Median of intersection cluster
                pts = np.array(intersections)
                cx_roi = float(np.median(pts[:, 0]))
                cy_roi = float(np.median(pts[:, 1]))
                line_confidence = min(0.95, 0.5 + len(intersections) * 0.05)

        # Global pixel coordinates
        cx_global = rx + cx_roi
        cy_global = ry + cy_roi

        # ── Step 4: Sub-pixel corner refinement ───────────────────────────────
        corner_pt = np.array([[[cx_roi, cy_roi]]], dtype=np.float32)
        criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 40, 0.001)
        try:
            refined = cv2.cornerSubPix(
                roi, corner_pt, (7, 7), (-1, -1), criteria
            )
            cx_global = rx + float(refined[0, 0, 0])
            cy_global = ry + float(refined[0, 0, 1])
        except Exception:
            pass  # use unrefined estimate

        # ── Step 5: Confidence score ───────────────────────────────────────────
        squareness = 1.0 - abs(1.0 - aspect)    # 1.0 = perfect square
        score = squareness * line_confidence

        if score > best_score:
            best_score = score
            best_center = (cx_global, cy_global)

    if best_center is None:
        return None

    return best_center[0], best_center[1], min(0.99, best_score)


def _line_intersection(
    line1: tuple[int, int, int, int],
    line2: tuple[int, int, int, int],
) -> Optional[tuple[float, float]]:
    """Return the intersection point of two line segments, or None if parallel."""
    np = _np()
    x1, y1, x2, y2 = line1
    x3, y3, x4, y4 = line2

    denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
    if abs(denom) < 1e-6:
        return None

    t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom
    px = x1 + t * (x2 - x1)
    py = y1 + t * (y2 - y1)
    return px, py


# ─── Main orchestration ────────────────────────────────────────────────────────

# ─── Spray-paint X detector ───────────────────────────────────────────────────

# Predefined HSV colour ranges for common spray colours.
# Each entry: (H_lo, H_hi, S_lo, V_lo)  — works on OpenCV H in [0,179]
_SPRAY_COLORS: dict[str, list[tuple[int, int, int, int]]] = {
    # Pink / magenta  (hue wraps — needs two bands)
    "pink":   [(140, 179, 60, 60), (0, 10, 60, 60)],
    "magenta": [(140, 179, 60, 60), (0, 10, 60, 60)],
    # Orange
    "orange": [(5, 25, 120, 80)],
    # Yellow
    "yellow": [(20, 40, 100, 80)],
    # Lime / fluorescent green
    "green":  [(35, 85, 100, 60)],
    # Blue
    "blue":   [(90, 130, 80, 50)],
    # Red (also wraps)
    "red":    [(0, 10, 100, 60), (165, 179, 100, 60)],
    # White — high V, low S
    "white":  [(0, 179, 0, 180)],
}


def detect_spray_paint(
    image_path: Path,
    color: str = "pink",
    min_area_px: int = 30,
    max_area_px: int = 80_000,
    morphology_close: int = 5,
) -> Optional[tuple[float, float, float]]:
    """
    Detect a spray-painted X/cross GCP marker by colour segmentation.

    Works for: pink, magenta, orange, yellow, green, blue, red, white spray.
    The center of the X (where the two strokes cross) is the GCP mark.

    Algorithm:
      1. Convert to HSV, threshold for the target colour
      2. Morphological close to fill gaps in spray strokes
      3. Find the largest qualifying blob  → that's the target
      4. Skeletonise the blob with thinning  → hairline X shape
      5. Hough line detection on skeleton  → intersect the two strokes
      6. Sub-pixel refinement with cornerSubPix
      7. Confidence = f(blob_area, skeleton_line_count, intersection_quality)
    """
    cv2 = _cv2()
    np = _np()

    img, gray = _load_gray(image_path)
    h_img, w_img = img.shape[:2]

    # Downsample large images to speed things up (detection still works)
    scale = 1.0
    if max(h_img, w_img) > 4000:
        scale = 4000 / max(h_img, w_img)
        img_small = cv2.resize(img, (int(w_img * scale), int(h_img * scale)))
    else:
        img_small = img

    hsv = cv2.cvtColor(img_small, cv2.COLOR_BGR2HSV)

    # Build colour mask from one or more HSV bands
    bands = _SPRAY_COLORS.get(color.lower(), _SPRAY_COLORS["pink"])
    mask = np.zeros(hsv.shape[:2], dtype=np.uint8)
    for h_lo, h_hi, s_lo, v_lo in bands:
        lo = np.array([h_lo, s_lo, v_lo], dtype=np.uint8)
        hi = np.array([h_hi, 255, 255], dtype=np.uint8)
        mask |= cv2.inRange(hsv, lo, hi)

    # Morphological close — fills spray stroke gaps
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (morphology_close, morphology_close))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, k, iterations=2)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, k, iterations=1)

    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None

    # Pick the largest blob within area bounds
    valid = [
        c for c in contours
        if min_area_px <= cv2.contourArea(c) <= max_area_px
    ]
    if not valid:
        return None

    best_cnt = max(valid, key=cv2.contourArea)
    blob_area = cv2.contourArea(best_cnt)

    # Bounding box and centroid as fallback
    M = cv2.moments(best_cnt)
    if M["m00"] == 0:
        return None
    cx_blob = M["m10"] / M["m00"]
    cy_blob = M["m01"] / M["m00"]

    # ROI crop around the blob for skeleton analysis
    bx, by, bw, bh = cv2.boundingRect(best_cnt)
    pad = max(10, int(max(bw, bh) * 0.15))
    rx = max(0, bx - pad);  ry = max(0, by - pad)
    rw = min(img_small.shape[1] - rx, bw + 2 * pad)
    rh = min(img_small.shape[0] - ry, bh + 2 * pad)
    roi_mask = mask[ry:ry + rh, rx:rx + rw]

    # Thin the mask to a skeleton — gives single-pixel X strokes
    try:
        skeleton = cv2.ximgproc.thinning(roi_mask, thinningType=cv2.ximgproc.THINNING_ZHANGSUEN)
    except AttributeError:
        # ximgproc not available — use erosion fallback
        skeleton = roi_mask.copy()
        kernel = np.ones((3, 3), np.uint8)
        for _ in range(5):
            skeleton = cv2.erode(skeleton, kernel)

    # Hough lines on the skeleton
    lines = cv2.HoughLinesP(
        skeleton, 1, np.pi / 180,
        threshold=max(8, int(min(bw, bh) * 0.2 * scale)),
        minLineLength=max(6, int(min(bw, bh) * 0.15 * scale)),
        maxLineGap=max(4, int(min(bw, bh) * 0.1 * scale)),
    )

    cx_final, cy_final = cx_blob, cy_blob
    line_conf = 0.3

    if lines is not None and len(lines) >= 2:
        intersections = []
        for i in range(len(lines)):
            for j in range(i + 1, len(lines)):
                pt = _line_intersection(lines[i][0], lines[j][0])
                if pt is not None:
                    px, py = pt
                    if 0 <= px <= rw and 0 <= py <= rh:
                        intersections.append((rx + px, ry + py))

        if intersections:
            pts = np.array(intersections)
            cx_final = float(np.median(pts[:, 0]))
            cy_final = float(np.median(pts[:, 1]))
            line_conf = min(0.92, 0.55 + len(intersections) * 0.05)

    # Sub-pixel refine on the downscaled grayscale
    gray_small = cv2.cvtColor(img_small, cv2.COLOR_BGR2GRAY)
    corner_pt = np.array([[[cx_final, cy_final]]], dtype=np.float32)
    criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 40, 0.001)
    try:
        refined = cv2.cornerSubPix(gray_small, corner_pt, (9, 9), (-1, -1), criteria)
        cx_final = float(refined[0, 0, 0])
        cy_final = float(refined[0, 0, 1])
    except Exception:
        pass

    # Scale back to full-image coordinates
    if scale < 1.0:
        cx_final /= scale
        cy_final /= scale

    # Confidence: area-normalised + line quality
    area_conf = min(0.8, blob_area / 2000.0)   # 2000 px² blob → 0.8
    confidence = min(0.97, (area_conf + line_conf) / 2)

    return cx_final, cy_final, confidence


STRATEGY_CHOICES = ["triangle_cross", "spray_paint", "checkerboard", "aruco", "circle_grid", "template", "blob"]


def run_auto_detect(
    image_dir: Path,
    image_meta: list[dict],
    gcps: list[dict],
    strategy: str = "triangle_cross",
    radius_m: float = 80.0,
    max_candidates: int = 30,
    # Checkerboard options
    cb_pattern: tuple[int, int] = (4, 4),
    # ArUco options
    aruco_dict_id: int = 0,
    aruco_marker_id: Optional[int] = None,
    # Circle grid options
    cg_pattern: tuple[int, int] = (4, 4),
    cg_asymmetric: bool = False,
    # Template options
    template_path: Optional[Path] = None,
    template_threshold: float = 0.65,
    # Blob options
    blob_min_area: float = 500.0,
    blob_max_area: float = 50000.0,
    # Spray paint options
    spray_color: str = "pink",
) -> list[dict]:
    """
    Run auto-detection for all GCPs.

    Each GCP dict must include `lat` and `lon` fields (decimal degrees) —
    these are the *known* survey coordinates used for the GPS pre-filter.

    Returns a list of DetectionResult dicts, one per successful detection.
    Multiple results per GCP are possible (one per candidate image).
    """
    if strategy not in STRATEGY_CHOICES:
        raise ValueError(f"strategy must be one of {STRATEGY_CHOICES}, got {strategy!r}")

    results: list[dict] = []
    t0 = time.perf_counter()

    for gcp in gcps:
        gcp_label = gcp.get("label", "GCP")
        gcp_lat = gcp.get("lat") or gcp.get("latitude")
        gcp_lon = gcp.get("lon") or gcp.get("longitude")

        if gcp_lat is None or gcp_lon is None:
            logger.warning(f"GCP {gcp_label!r} has no lat/lon — skipping GPS filter, scanning all")
            candidates = image_meta[:max_candidates]
        else:
            candidates = filter_images_near_gcp(image_meta, gcp_lat, gcp_lon, radius_m)
            logger.info(
                f"GCP {gcp_label!r}: {len(candidates)} candidates "
                f"within {radius_m}m of ({gcp_lat:.6f}, {gcp_lon:.6f})"
            )

        candidates = candidates[:max_candidates]
        gcp_hits: list[DetectionResult] = []

        for img_meta in candidates:
            filename = img_meta.get("filename") or img_meta.get("image_name", "")
            image_path = image_dir / filename
            if not image_path.exists():
                continue

            try:
                det = _run_strategy(
                    strategy, image_path,
                    cb_pattern, aruco_dict_id, aruco_marker_id,
                    cg_pattern, cg_asymmetric,
                    template_path, template_threshold,
                    blob_min_area, blob_max_area,
                )
            except Exception as exc:
                logger.debug(f"  {filename}: detection error — {exc}")
                continue

            if det is None:
                continue

            if strategy == "aruco":
                cx, cy, conf, marker_id = det
                extra = {"marker_id": marker_id}
            else:
                cx, cy, conf = det
                extra = {}

            gcp_hits.append(DetectionResult(
                gcp_label=gcp_label,
                image_name=filename,
                pixel_x=round(cx, 2),
                pixel_y=round(cy, 2),
                confidence=round(conf, 4),
                strategy=strategy,
                candidates_scanned=len(candidates),
                elapsed_s=round(time.perf_counter() - t0, 2),
                extra=extra,
            ))
            logger.info(f"  ✓ {filename}: ({cx:.0f}, {cy:.0f}) conf={conf:.3f}")

        # Sort by confidence descending
        gcp_hits.sort(key=lambda r: r.confidence, reverse=True)
        results.extend(r.to_dict() for r in gcp_hits)

    logger.info(
        f"Auto-detect complete: {len(results)} hits across {len(gcps)} GCPs "
        f"in {time.perf_counter() - t0:.1f}s"
    )
    return results


def _run_strategy(
    strategy: str,
    image_path: Path,
    cb_pattern, aruco_dict_id, aruco_marker_id,
    cg_pattern, cg_asymmetric,
    template_path, template_threshold,
    blob_min_area, blob_max_area,
    spray_color: str = "pink",
):
    if strategy == "triangle_cross":
        return detect_triangle_cross(image_path)
    elif strategy == "spray_paint":
        return detect_spray_paint(image_path, color=spray_color)
    elif strategy == "checkerboard":
        return detect_checkerboard(image_path, cb_pattern)
    elif strategy == "aruco":
        return detect_aruco(image_path, aruco_dict_id, aruco_marker_id)
    elif strategy == "circle_grid":
        return detect_circle_grid(image_path, cg_pattern, cg_asymmetric)
    elif strategy == "template":
        if template_path is None:
            raise ValueError("template_path is required for template strategy")
        return detect_template(image_path, template_path, template_threshold)
    elif strategy == "blob":
        return detect_blob(image_path, blob_min_area, blob_max_area)
    else:
        raise ValueError(f"Unknown strategy: {strategy}")
