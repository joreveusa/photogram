/**
 * FlightPlanner — interactive lawnmower flight path generator.
 * Draw a polygon on a Leaflet map → configure altitude/overlap →
 * generate a grid path → export as KML, GPX, or CSV.
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// Fix Leaflet icon
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
});

// ─── Types ────────────────────────────────────────────────────────────────────

interface LatLon { lat: number; lon: number; }
interface FlightParams {
  altitude: number;     // metres AGL
  speed: number;        // m/s
  overlap: number;      // % front overlap
  sidelap: number;      // % side overlap
  fov: number;          // camera FOV degrees
  heading: number;      // 0=N,90=E strip orientation
}
interface PathStats {
  waypointCount: number;
  distanceKm: number;
  flightTimeMins: number;
  areaHa: number;
  stripCount: number;
}

const DEFAULT_PARAMS: FlightParams = {
  altitude: 120, speed: 10, overlap: 80, sidelap: 70, fov: 84, heading: 0,
};

// ─── Maths helpers ────────────────────────────────────────────────────────────

const DEG2RAD = Math.PI / 180;
const R_EARTH  = 6371000; // metres

/** Haversine distance in metres */
function haversine(a: LatLon, b: LatLon): number {
  const dLat = (b.lat - a.lat) * DEG2RAD;
  const dLon = (b.lon - a.lon) * DEG2RAD;
  const x = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * DEG2RAD) * Math.cos(b.lat * DEG2RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(x));
}

/** Offset a lat/lon by dx(E) and dy(N) metres */
function offset(p: LatLon, dxE: number, dyN: number): LatLon {
  return {
    lat: p.lat + (dyN / R_EARTH) * (180 / Math.PI),
    lon: p.lon + (dxE / R_EARTH) * (180 / Math.PI) / Math.cos(p.lat * DEG2RAD),
  };
}

/** Polygon area via shoelace (approximate, metres²) */
function polygonArea(pts: LatLon[]): number {
  if (pts.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    const xi = pts[i].lon * DEG2RAD * R_EARTH * Math.cos(pts[i].lat * DEG2RAD);
    const yi = pts[i].lat * DEG2RAD * R_EARTH;
    const xj = pts[j].lon * DEG2RAD * R_EARTH * Math.cos(pts[j].lat * DEG2RAD);
    const yj = pts[j].lat * DEG2RAD * R_EARTH;
    area += xi * yj - xj * yi;
  }
  return Math.abs(area / 2);
}

// ─── Lawnmower path generator ─────────────────────────────────────────────────

function generatePath(polygon: LatLon[], p: FlightParams): LatLon[] {
  if (polygon.length < 3) return [];

  const footprintW = 2 * p.altitude * Math.tan((p.fov / 2) * DEG2RAD);
  const stripSpacing = footprintW * (1 - p.sidelap / 100);
  const waypointSpacing = footprintW * (1 - p.overlap / 100);

  // Bounding box in the heading-rotated frame
  const cx = polygon.reduce((s, v) => s + v.lon, 0) / polygon.length;
  const cy = polygon.reduce((s, v) => s + v.lat, 0) / polygon.length;
  const centre: LatLon = { lat: cy, lon: cx };

  const angle = p.heading * DEG2RAD;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  // Project all vertices into rotated frame (metres from centre)
  const rotated = polygon.map(v => {
    const dxE = (v.lon - cx) * DEG2RAD * R_EARTH * Math.cos(cy * DEG2RAD);
    const dyN = (v.lat - cy) * DEG2RAD * R_EARTH;
    return { u: cos * dxE + sin * dyN, v: -sin * dxE + cos * dyN };
  });

  const minU = Math.min(...rotated.map(r => r.u));
  const maxU = Math.max(...rotated.map(r => r.u));
  const minV = Math.min(...rotated.map(r => r.v));
  const maxV = Math.max(...rotated.map(r => r.v));

  const waypoints: LatLon[] = [];
  let stripIdx = 0;

  for (let u = minU + stripSpacing / 2; u <= maxU; u += stripSpacing) {
    const isForward = stripIdx % 2 === 0;
    const vStart = isForward ? minV : maxV;
    const vEnd   = isForward ? maxV : minV;
    const vStep  = isForward ? waypointSpacing : -waypointSpacing;

    for (let v = vStart; isForward ? v <= vEnd : v >= vEnd; v += vStep) {
      // Un-rotate back to E/N
      const dxE = cos * u - sin * v;
      const dyN = sin * u + cos * v;
      waypoints.push(offset(centre, dxE, dyN));
    }
    stripIdx++;
  }

  return waypoints;
}

// ─── Export helpers ───────────────────────────────────────────────────────────

function toKML(wps: LatLon[], alt: number): string {
  const placemarks = wps.map((w, i) => `    <Placemark>
      <name>WP${i + 1}</name>
      <Point><coordinates>${w.lon.toFixed(7)},${w.lat.toFixed(7)},${alt}</coordinates></Point>
    </Placemark>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>PhotoForge Flight Plan</name>
    <Style id="path"><LineStyle><color>ff00d4aa</color><width>2</width></LineStyle></Style>
    <Placemark><name>Flight Path</name><styleUrl>#path</styleUrl>
      <LineString><coordinates>${wps.map(w => `${w.lon.toFixed(7)},${w.lat.toFixed(7)},${alt}`).join(' ')}</coordinates></LineString>
    </Placemark>
${placemarks}
  </Document>
</kml>`;
}

function toGPX(wps: LatLon[], alt: number): string {
  const wpts = wps.map((w, i) =>
    `  <wpt lat="${w.lat.toFixed(7)}" lon="${w.lon.toFixed(7)}"><ele>${alt}</ele><name>WP${i + 1}</name></wpt>`
  ).join('\n');
  const trkpts = wps.map(w =>
    `      <trkpt lat="${w.lat.toFixed(7)}" lon="${w.lon.toFixed(7)}"><ele>${alt}</ele></trkpt>`
  ).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="PhotoForge" xmlns="http://www.topografix.com/GPX/1/1">
${wpts}
  <trk><name>Flight Path</name><trkseg>
${trkpts}
  </trkseg></trk>
</gpx>`;
}

function toCSV(wps: LatLon[], alt: number, speed: number): string {
  return ['latitude,longitude,altitude_m,speed_ms',
    ...wps.map(w => `${w.lat.toFixed(7)},${w.lon.toFixed(7)},${alt},${speed}`)
  ].join('\n');
}

function download(content: string, filename: string, mime: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: mime }));
  a.download = filename;
  a.click();
}

// ─── Numeric input helper ─────────────────────────────────────────────────────

function NumInput({ label, value, onChange, min, max, step, unit }: {
  label: string; value: number; onChange: (v: number) => void;
  min?: number; max?: number; step?: number; unit?: string;
}) {
  return (
    <div className="form-group" style={{ marginBottom: 12 }}>
      <label style={{ fontSize: 11, marginBottom: 4, display: 'flex', justifyContent: 'space-between' }}>
        <span>{label}</span>
        {unit && <span style={{ color: 'var(--text-muted)' }}>{unit}</span>}
      </label>
      <input
        type="number" className="input"
        style={{ fontSize: 13, padding: '6px 10px' }}
        value={value} min={min} max={max} step={step ?? 1}
        onChange={e => onChange(Number(e.target.value))}
      />
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function FlightPlanner() {
  const navigate = useNavigate();
  const mapRef   = useRef<HTMLDivElement>(null);
  const lMapRef  = useRef<L.Map | null>(null);

  // Drawing state
  const [polygon, setPolygon]   = useState<LatLon[]>([]);
  const [closed, setClosed]     = useState(false);
  const [params, setParams]     = useState<FlightParams>(DEFAULT_PARAMS);
  const [path, setPath]         = useState<LatLon[]>([]);
  const [stats, setStats]       = useState<PathStats | null>(null);
  const [drawing, setDrawing]   = useState(false);

  // Leaflet layers refs
  const polyLayerRef = useRef<L.LayerGroup | null>(null);
  const pathLayerRef = useRef<L.LayerGroup | null>(null);

  // ── Init map ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapRef.current || lMapRef.current) return;

    const map = L.map(mapRef.current, {
      center: [39.5, -98.35],
      zoom: 5,
      zoomControl: true,
    });

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '© CartoDB', maxZoom: 19, subdomains: 'abcd',
    }).addTo(map);

    polyLayerRef.current = L.layerGroup().addTo(map);
    pathLayerRef.current = L.layerGroup().addTo(map);
    lMapRef.current = map;

    return () => { map.remove(); lMapRef.current = null; };
  }, []);

  // ── Map click handler ───────────────────────────────────────────────────────
  useEffect(() => {
    const map = lMapRef.current;
    if (!map) return;

    const onClick = (e: L.LeafletMouseEvent) => {
      if (closed) return;
      const pt: LatLon = { lat: e.latlng.lat, lon: e.latlng.lng };
      setPolygon(prev => [...prev, pt]);
      setDrawing(true);
    };

    map.on('click', onClick);
    return () => { map.off('click', onClick); };
  }, [closed]);

  // ── Re-draw polygon layer when polygon changes ──────────────────────────────
  useEffect(() => {
    const layer = polyLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    if (polygon.length === 0) return;

    const ll = polygon.map(p => [p.lat, p.lon] as L.LatLngExpression);

    // Vertices
    polygon.forEach((p, i) => {
      L.circleMarker([p.lat, p.lon], {
        radius: 5,
        color: '#00d4aa', fillColor: '#00d4aa', fillOpacity: 1, weight: 2,
      }).bindTooltip(`Vertex ${i + 1}`, { permanent: false }).addTo(layer);
    });

    // Lines
    if (ll.length > 1) {
      L.polyline(closed ? [...ll, ll[0]] : ll, {
        color: '#00d4aa', weight: 2, dashArray: closed ? undefined : '5 5', opacity: 0.8,
      }).addTo(layer);
    }

    if (closed) {
      L.polygon(ll, {
        color: '#00d4aa', weight: 2, fillColor: '#00d4aa', fillOpacity: 0.12,
      }).addTo(layer);
    }
  }, [polygon, closed]);

  // ── Re-draw path layer ──────────────────────────────────────────────────────
  useEffect(() => {
    const layer = pathLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    if (path.length === 0) return;

    const ll = path.map(p => [p.lat, p.lon] as L.LatLngExpression);
    L.polyline(ll, { color: '#f59e0b', weight: 1.5, opacity: 0.9 }).addTo(layer);

    // Waypoint dots
    path.forEach((p, i) => {
      if (i % Math.max(1, Math.floor(path.length / 60)) === 0) {
        L.circleMarker([p.lat, p.lon], {
          radius: 2, color: '#f59e0b', fillColor: '#f59e0b', fillOpacity: 1, weight: 1,
        }).addTo(layer);
      }
    });
  }, [path]);

  // ── Actions ─────────────────────────────────────────────────────────────────
  const closePolygon = () => {
    if (polygon.length >= 3) setClosed(true);
  };

  const generateFlightPath = () => {
    if (polygon.length < 3) return;
    const wps = generatePath(polygon, params);
    setPath(wps);

    // Compute stats
    let dist = 0;
    for (let i = 1; i < wps.length; i++) dist += haversine(wps[i - 1], wps[i]);
    const area = polygonArea(polygon);
    const footprintW = 2 * params.altitude * Math.tan((params.fov / 2) * DEG2RAD);
    const stripSpacing = footprintW * (1 - params.sidelap / 100);

    setStats({
      waypointCount: wps.length,
      distanceKm: dist / 1000,
      flightTimeMins: (dist / params.speed) / 60,
      areaHa: area / 10000,
      stripCount: Math.ceil(Math.sqrt(area) / stripSpacing),
    });

    // Fit map to path
    if (wps.length > 0 && lMapRef.current) {
      const bounds = L.latLngBounds(wps.map(w => [w.lat, w.lon] as L.LatLngExpression));
      lMapRef.current.fitBounds(bounds, { padding: [24, 24] });
    }
  };

  const clearAll = () => {
    setPolygon([]); setClosed(false); setPath([]); setStats(null); setDrawing(false);
    polyLayerRef.current?.clearLayers();
    pathLayerRef.current?.clearLayers();
  };

  const setParam = <K extends keyof FlightParams>(k: K, v: number) =>
    setParams(prev => ({ ...prev, [k]: v }));

  const footprintM = 2 * params.altitude * Math.tan((params.fov / 2) * DEG2RAD);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 0px)', overflow: 'hidden' }}>
      {/* Toolbar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '10px 20px',
        background: 'var(--bg-card)', borderBottom: '1px solid var(--border)', flexShrink: 0,
      }}>
        <button className="btn btn-ghost btn-sm" onClick={() => navigate('/')}>← Back</button>
        <div style={{ fontWeight: 700, fontSize: 16 }}>✈️ Flight Path Planner</div>
        <div className="text-xs text-muted" style={{ flex: 1 }}>
          {!drawing
            ? 'Click on the map to draw your flight area polygon'
            : !closed
            ? `${polygon.length} vertices — click "Close Polygon" when done`
            : path.length === 0
            ? 'Polygon ready — adjust parameters and click Generate'
            : `${stats?.waypointCount} waypoints · ${stats?.distanceKm.toFixed(2)} km · ~${stats?.flightTimeMins.toFixed(0)} min`}
        </div>
        {polygon.length >= 3 && !closed && (
          <button className="btn btn-primary btn-sm" onClick={closePolygon}>Close Polygon</button>
        )}
        {closed && (
          <button className="btn btn-primary btn-sm" onClick={generateFlightPath}>⚡ Generate Path</button>
        )}
        {path.length > 0 && (
          <>
            <button className="btn btn-secondary btn-sm" onClick={() => download(toKML(path, params.altitude), 'flight_plan.kml', 'application/vnd.google-earth.kml+xml')}>
              ↓ KML
            </button>
            <button className="btn btn-secondary btn-sm" onClick={() => download(toGPX(path, params.altitude), 'flight_plan.gpx', 'application/gpx+xml')}>
              ↓ GPX
            </button>
            <button className="btn btn-secondary btn-sm" onClick={() => download(toCSV(path, params.altitude, params.speed), 'flight_plan.csv', 'text/csv')}>
              ↓ CSV
            </button>
          </>
        )}
        <button className="btn btn-ghost btn-sm text-error" onClick={clearAll}>✕ Clear</button>
      </div>

      {/* Body */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Map */}
        <div ref={mapRef} style={{ flex: 1, minWidth: 0, minHeight: 400 }} />

        {/* Params panel */}
        <div style={{
          width: 280, flexShrink: 0, overflowY: 'auto',
          background: 'var(--bg-card)', borderLeft: '1px solid var(--border)',
          padding: '20px 16px',
        }}>
          <h4 className="mb-4">Flight Parameters</h4>

          <NumInput label="Altitude AGL" value={params.altitude} onChange={v => setParam('altitude', v)} min={20} max={500} unit="m" />
          <NumInput label="Speed" value={params.speed} onChange={v => setParam('speed', v)} min={1} max={30} step={0.5} unit="m/s" />
          <NumInput label="Front Overlap" value={params.overlap} onChange={v => setParam('overlap', v)} min={0} max={95} unit="%" />
          <NumInput label="Side Overlap (Sidelap)" value={params.sidelap} onChange={v => setParam('sidelap', v)} min={0} max={95} unit="%" />
          <NumInput label="Camera FOV" value={params.fov} onChange={v => setParam('fov', v)} min={30} max={180} unit="°" />
          <NumInput label="Strip Heading" value={params.heading} onChange={v => setParam('heading', v)} min={0} max={359} unit="°" />

          {/* Computed info */}
          <div className="separator" style={{ margin: '16px 0' }} />
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            <div className="flex justify-between mb-2">
              <span className="text-muted">Ground footprint</span>
              <span>{footprintM.toFixed(1)} m</span>
            </div>
            <div className="flex justify-between mb-2">
              <span className="text-muted">Strip spacing</span>
              <span>{(footprintM * (1 - params.sidelap / 100)).toFixed(1)} m</span>
            </div>
            <div className="flex justify-between mb-2">
              <span className="text-muted">WP spacing</span>
              <span>{(footprintM * (1 - params.overlap / 100)).toFixed(1)} m</span>
            </div>
          </div>

          {stats && (
            <>
              <div className="separator" style={{ margin: '16px 0' }} />
              <h4 className="mb-3">Plan Summary</h4>
              <div className="flex-col gap-2">
                {[
                  { label: 'Waypoints', value: stats.waypointCount.toLocaleString() },
                  { label: 'Total Distance', value: `${stats.distanceKm.toFixed(2)} km` },
                  { label: 'Est. Flight Time', value: `${stats.flightTimeMins.toFixed(0)} min` },
                  { label: 'Coverage Area', value: `${stats.areaHa.toFixed(2)} ha` },
                  { label: 'Strips', value: stats.stripCount.toString() },
                ].map(({ label, value }) => (
                  <div key={label} className="flex justify-between" style={{ fontSize: 12 }}>
                    <span className="text-muted">{label}</span>
                    <span style={{ fontWeight: 600, color: 'var(--accent)' }}>{value}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* Tips */}
          <div className="separator" style={{ margin: '16px 0' }} />
          <div style={{
            fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.6,
            background: 'var(--bg-elevated)', borderRadius: 8, padding: '10px 12px',
          }}>
            <strong style={{ color: 'var(--text-secondary)' }}>Tips</strong><br />
            • Click map to add vertices<br />
            • 80% overlap for photogrammetry<br />
            • 70% sidelap minimum<br />
            • Higher altitude = wider strips, fewer photos<br />
            • Match heading to wind direction
          </div>
        </div>
      </div>
    </div>
  );
}
