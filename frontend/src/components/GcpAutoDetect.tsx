/**
 * GcpAutoDetect.tsx
 * 
 * Slide-in panel that lets users run AI/CV detection of GCP targets in their
 * uploaded aerial photos. Supports all 6 detection strategies:
 *   triangle_cross (default — pinwheel B&W panels)
 *   checkerboard | aruco | circle_grid | template | blob
 *
 * Props:
 *   projectId  : string        — project to scan
 *   gcps       : GCPPoint[]   — list of GCPs with known coords
 *   gcpCoords  : Record<string,{lat,lon}> — lat/lon for each GCP label
 *   onAccept   : (gcp_label, image_name, pixel_x, pixel_y) => void
 *   onClose    : () => void
 */

import React, { useState, useCallback } from 'react';
import {
  projectsApi,
  AutoDetectResult,
  DetectionStrategy,
  GCPPoint,
} from '../api';

// ─── Constants ────────────────────────────────────────────────────────────────

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

const STRATEGY_META: Record<DetectionStrategy, { label: string; desc: string; icon: string }> = {
  triangle_cross: {
    label: 'Pinwheel Panel',
    icon: '◈',
    desc: 'Standard B&W triangle-cross target (4 alternating triangles). Best for Red Tail Surveying GCP panels.',
  },
  spray_paint: {
    label: 'Spray Paint X',
    icon: '✕',
    desc: 'Spray-painted X or cross on the ground. Pick the spray colour — pink, orange, yellow, blue, red, green.',
  },
  checkerboard: {
    label: 'Checkerboard',
    icon: '⊞',
    desc: 'Classic checkerboard grid panel. Specify inner corner count.',
  },
  aruco: {
    label: 'ArUco Marker',
    icon: '⬛',
    desc: 'Coded square markers with unique IDs. Highly reliable when markers are used.',
  },
  circle_grid: {
    label: 'Circle Grid',
    icon: '⊙',
    desc: 'Symmetric or asymmetric dot-grid panel.',
  },
  template: {
    label: 'Template Match',
    icon: '⊡',
    desc: 'Upload a reference photo of your target — any shape, any panel.',
  },
  blob: {
    label: 'High-Contrast Blob',
    icon: '◉',
    desc: 'Generic large-area target (orange panels, painted marks, etc.).',
  },
};

interface Props {
  projectId: string;
  gcps: GCPPoint[];
  gcpCoords: Record<string, { lat: number; lon: number }>;
  onAccept: (gcpLabel: string, imageName: string, pixelX: number, pixelY: number) => void;
  onReject: (gcpLabel: string, imageName: string) => void;
  onClose: () => void;
}

interface GroupedResult {
  gcpLabel: string;
  hits: AutoDetectResult[];         // all hits from detector
  acceptedImages: Set<string>;      // auto-accepted on scan
  rejectedImages: Set<string>;      // manually rejected by user
  skipped?: boolean;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function GcpAutoDetect({ projectId, gcps, gcpCoords, onAccept, onReject, onClose }: Props) {
  const [strategy, setStrategy] = useState<DetectionStrategy>('triangle_cross');
  const [radiusM, setRadiusM] = useState(80);
  const [maxCandidates, setMaxCandidates] = useState(30);
  const [minConfidence, setMinConfidence] = useState(0.4); // auto-accept threshold

  // Checkerboard options
  const [cbCols, setCbCols] = useState(4);
  const [cbRows, setCbRows] = useState(4);

  // ArUco options
  const [arucoDict, setArucoDict] = useState(0);
  const [arucoId, setArucoId] = useState<string>('');

  // Spray paint options
  const [sprayColor, setSprayColor] = useState('pink');

  // Status
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [grouped, setGrouped] = useState<GroupedResult[] | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [autoAcceptedCount, setAutoAcceptedCount] = useState(0);


  // ── Run detection ──────────────────────────────────────────────────────────

  const handleRun = useCallback(async () => {
    setRunning(true);
    setError(null);
    setGrouped(null);
    setElapsed(null);

    const t0 = Date.now();

    // Build GCPs list with lat/lon from gcpCoords
    const gcpPayload = gcps
      .filter(g => gcpCoords[g.label])
      .map(g => ({
        label: g.label,
        x: g.x,
        y: g.y,
        z: g.z,
        lat: gcpCoords[g.label].lat,
        lon: gcpCoords[g.label].lon,
      }));

    if (gcpPayload.length === 0) {
      setError('No GCPs have known lat/lon coordinates. Add GCP coordinates first.');
      setRunning(false);
      return;
    }

    const options: Record<string, unknown> = {};
    if (strategy === 'checkerboard') {
      options.cb_pattern = [cbCols, cbRows];
    } else if (strategy === 'aruco') {
      options.aruco_dict_id = arucoDict;
      if (arucoId.trim()) options.aruco_marker_id = parseInt(arucoId, 10);
    } else if (strategy === 'spray_paint') {
      options.spray_color = sprayColor;
    }

    try {
      const results = await projectsApi.autoDetectGCPs(projectId, {
        strategy,
        gcps: gcpPayload,
        radius_m: radiusM,
        max_candidates: maxCandidates,
        options,
      });

      setElapsed(Math.round((Date.now() - t0) / 1000));

      // Group by gcp_label, sorted by confidence desc (backend already does this, but be safe)
      const groups: Record<string, AutoDetectResult[]> = {};
      for (const r of results) {
        if (!groups[r.gcp_label]) groups[r.gcp_label] = [];
        groups[r.gcp_label].push(r);
      }

      // Auto-accept: best hit per GCP (if above threshold) + any additional hits above threshold
      let totalAccepted = 0;
      const grouped: GroupedResult[] = gcpPayload.map(g => {
        const hits = groups[g.label] ?? [];
        const autoAccepted = new Set<string>();

        // Accept hits that meet the confidence threshold (already sorted best-first)
        for (const hit of hits) {
          if (hit.confidence >= minConfidence) {
            onAccept(hit.gcp_label, hit.image_name, hit.pixel_x, hit.pixel_y);
            autoAccepted.add(hit.image_name);
            totalAccepted++;
          }
        }

        // If nothing met the threshold, accept the best hit anyway (don't leave GCP empty)
        if (autoAccepted.size === 0 && hits.length > 0) {
          const best = hits[0];
          onAccept(best.gcp_label, best.image_name, best.pixel_x, best.pixel_y);
          autoAccepted.add(best.image_name);
          totalAccepted++;
        }

        return {
          gcpLabel: g.label,
          hits,
          acceptedImages: autoAccepted,
          rejectedImages: new Set<string>(),
        };
      });

      setAutoAcceptedCount(totalAccepted);
      setGrouped(grouped);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { detail?: string } }; message?: string })
        ?.response?.data?.detail ?? (err as Error)?.message ?? 'Detection failed';
      setError(msg);
    } finally {
      setRunning(false);
    }
  }, [projectId, gcps, gcpCoords, strategy, radiusM, maxCandidates, minConfidence, cbCols, cbRows, arucoDict, arucoId, onAccept]);

  // ── Reject a single auto-accepted hit ─────────────────────────────────────

  const reject = (groupIdx: number, hit: AutoDetectResult) => {
    onReject(hit.gcp_label, hit.image_name);
    setGrouped(prev =>
      prev
        ? prev.map((g, i) =>
            i === groupIdx
              ? {
                  ...g,
                  acceptedImages: new Set([...g.acceptedImages].filter(n => n !== hit.image_name)),
                  rejectedImages: new Set([...g.rejectedImages, hit.image_name]),
                }
              : g
          )
        : prev
    );
  };

  // ── Re-accept a previously rejected hit ───────────────────────────────────

  const reAccept = (groupIdx: number, hit: AutoDetectResult) => {
    onAccept(hit.gcp_label, hit.image_name, hit.pixel_x, hit.pixel_y);
    setGrouped(prev =>
      prev
        ? prev.map((g, i) =>
            i === groupIdx
              ? {
                  ...g,
                  acceptedImages: new Set([...g.acceptedImages, hit.image_name]),
                  rejectedImages: new Set([...g.rejectedImages].filter(n => n !== hit.image_name)),
                }
              : g
          )
        : prev
    );
  };

  const confidenceColor = (c: number) => {
    if (c >= 0.8) return '#4ade80';   // green
    if (c >= 0.5) return '#facc15';   // yellow
    return '#f87171';                  // red
  };

  const thumbnailUrl = (filename: string) =>
    `${API_URL}/projects/${projectId}/thumbnail/${encodeURIComponent(filename)}`;

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div style={styles.overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={styles.panel}>

        {/* ── Header ── */}
        <div style={styles.header}>
          <div>
            <h2 style={styles.title}>🎯 Auto-Detect GCP Targets</h2>
            <p style={styles.subtitle}>
              AI scans your photos and locates targets automatically
            </p>
          </div>
          <button id="gcp-autodetect-close" style={styles.closeBtn} onClick={onClose}>✕</button>
        </div>

        {/* ── Strategy selector ── */}
        <div style={styles.section}>
          <label style={styles.sectionLabel}>Detection Strategy</label>
          <div style={styles.strategyGrid}>
            {(Object.keys(STRATEGY_META) as DetectionStrategy[]).map(s => {
              const meta = STRATEGY_META[s];
              const active = strategy === s;
              return (
                <button
                  key={s}
                  id={`strategy-${s}`}
                  style={{ ...styles.strategyCard, ...(active ? styles.strategyCardActive : {}) }}
                  onClick={() => setStrategy(s)}
                  title={meta.desc}
                >
                  <span style={styles.strategyIcon}>{meta.icon}</span>
                  <span style={styles.strategyLabel}>{meta.label}</span>
                  {s === 'triangle_cross' && (
                    <span style={styles.badge}>Default</span>
                  )}
                </button>
              );
            })}
          </div>
          <p style={styles.strategyDesc}>{STRATEGY_META[strategy].desc}</p>
        </div>

        {/* ── Strategy-specific options ── */}
        {strategy === 'spray_paint' && (
          <div style={styles.section}>
            <label style={styles.sectionLabel}>Spray Paint Colour</label>
            <div style={styles.colorGrid}>
              {[
                { id: 'pink',   label: 'Pink / Magenta', hex: '#e879f9' },
                { id: 'orange', label: 'Orange',          hex: '#fb923c' },
                { id: 'yellow', label: 'Yellow',          hex: '#facc15' },
                { id: 'green',  label: 'Lime Green',      hex: '#4ade80' },
                { id: 'blue',   label: 'Blue',            hex: '#60a5fa' },
                { id: 'red',    label: 'Red',             hex: '#f87171' },
                { id: 'white',  label: 'White',           hex: '#f1f5f9' },
              ].map(c => (
                <button
                  key={c.id}
                  id={`spray-color-${c.id}`}
                  style={{
                    ...styles.colorSwatch,
                    border: sprayColor === c.id
                      ? `2px solid ${c.hex}`
                      : '2px solid transparent',
                    boxShadow: sprayColor === c.id ? `0 0 10px ${c.hex}60` : 'none',
                  }}
                  onClick={() => setSprayColor(c.id)}
                  title={c.label}
                >
                  <span style={{ ...styles.swatchDot, background: c.hex }} />
                  <span style={{ fontSize: '11px', color: sprayColor === c.id ? '#e2e8f0' : '#64748b' }}>
                    {c.label}
                  </span>
                </button>
              ))}
            </div>
            <p style={styles.hint}>Choose the colour closest to your spray paint.</p>
          </div>
        )}

        {strategy === 'checkerboard' && (
          <div style={styles.section}>
            <label style={styles.sectionLabel}>Inner Corner Count</label>
            <div style={styles.row}>
              <div style={styles.field}>
                <label style={styles.fieldLabel}>Columns</label>
                <input id="cb-cols" type="number" min={2} max={20} value={cbCols}
                  onChange={e => setCbCols(parseInt(e.target.value) || 4)}
                  style={styles.input} />
              </div>
              <div style={styles.field}>
                <label style={styles.fieldLabel}>Rows</label>
                <input id="cb-rows" type="number" min={2} max={20} value={cbRows}
                  onChange={e => setCbRows(parseInt(e.target.value) || 4)}
                  style={styles.input} />
              </div>
            </div>
            <p style={styles.hint}>Count the intersections inside the grid — not the squares.</p>
          </div>
        )}

        {strategy === 'aruco' && (
          <div style={styles.section}>
            <label style={styles.sectionLabel}>ArUco Options</label>
            <div style={styles.row}>
              <div style={styles.field}>
                <label style={styles.fieldLabel}>Dictionary</label>
                <select id="aruco-dict" value={arucoDict}
                  onChange={e => setArucoDict(parseInt(e.target.value))}
                  style={styles.select}>
                  <option value={0}>4×4 (50)</option>
                  <option value={1}>4×4 (100)</option>
                  <option value={4}>5×5 (50)</option>
                  <option value={8}>6×6 (50)</option>
                  <option value={12}>7×7 (50)</option>
                </select>
              </div>
              <div style={styles.field}>
                <label style={styles.fieldLabel}>Marker ID (optional)</label>
                <input id="aruco-id" type="number" min={0} value={arucoId}
                  placeholder="Any"
                  onChange={e => setArucoId(e.target.value)}
                  style={styles.input} />
              </div>
            </div>
          </div>
        )}

        {/* ── GPS & scan options ── */}
        <div style={styles.section}>
          <label style={styles.sectionLabel}>Scan Options</label>
          <div style={styles.row}>
            <div style={styles.field}>
              <label style={styles.fieldLabel}>GPS Radius (m)</label>
              <input id="gcp-radius" type="number" min={10} max={500} value={radiusM}
                onChange={e => setRadiusM(parseInt(e.target.value) || 80)}
                style={styles.input} />
            </div>
            <div style={styles.field}>
              <label style={styles.fieldLabel}>Max Photos per GCP</label>
              <input id="gcp-max-cands" type="number" min={5} max={100} value={maxCandidates}
                onChange={e => setMaxCandidates(parseInt(e.target.value) || 30)}
                style={styles.input} />
            </div>
          </div>
          <div style={{ marginTop: 12 }}>
            <label style={styles.fieldLabel}>
              Min Confidence to Auto-Accept — <span style={{ color: '#a5b4fc' }}>{Math.round(minConfidence * 100)}%</span>
            </label>
            <input
              id="gcp-min-confidence"
              type="range" min={0} max={90} step={5}
              value={Math.round(minConfidence * 100)}
              onChange={e => setMinConfidence(parseInt(e.target.value) / 100)}
              style={{ width: '100%', marginTop: 6, accentColor: '#6366f1' }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#475569', marginTop: 2 }}>
              <span>Accept everything</span>
              <span>Only high-confidence</span>
            </div>
          </div>
          <p style={styles.hint}>
            Only photos taken within {radiusM}m of each GCP coordinate will be scanned. Matches above {Math.round(minConfidence * 100)}% confidence are auto-applied.
          </p>
        </div>

        {/* ── GCPs to scan ── */}
        <div style={styles.section}>
          <label style={styles.sectionLabel}>
            GCPs to Scan ({gcps.filter(g => gcpCoords[g.label]).length} with coordinates)
          </label>
          <div style={styles.gcpChips}>
            {gcps.map(g => {
              const hasCoords = !!gcpCoords[g.label];
              return (
                <div key={g.label} style={{ ...styles.chip, opacity: hasCoords ? 1 : 0.4 }}
                  title={hasCoords ? `${gcpCoords[g.label].lat.toFixed(6)}, ${gcpCoords[g.label].lon.toFixed(6)}` : 'No lat/lon — cannot scan'}>
                  {hasCoords ? '📍' : '⚠️'} {g.label}
                </div>
              );
            })}
            {gcps.length === 0 && (
              <p style={styles.hint}>No GCPs defined yet. Add GCPs first.</p>
            )}
          </div>
        </div>

        {/* ── Run button ── */}
        <div style={styles.section}>
          <button
            id="gcp-autodetect-run"
            style={{ ...styles.runBtn, ...(running ? styles.runBtnDisabled : {}) }}
            disabled={running || gcps.filter(g => gcpCoords[g.label]).length === 0}
            onClick={handleRun}
          >
            {running ? (
              <><span style={styles.spinner} />  Scanning photos…</>
            ) : (
              <> 🔍  Run Auto-Detection</>
            )}
          </button>
          {running && (
            <p style={styles.runningHint}>
              Using GPS to pre-filter, then running CV on candidates…
            </p>
          )}
        </div>

        {/* ── Error ── */}
        {error && (
          <div style={styles.errorBox}>
            <strong>⚠ Detection Error</strong>
            <p style={{ margin: '4px 0 0' }}>{error}</p>
          </div>
        )}

        {/* ── Results ── */}
        {grouped !== null && (
          <div style={styles.section}>
            {/* ── Auto-accept summary banner ── */}
            <div style={styles.successBanner}>
              <span style={{ fontSize: 18 }}>✅</span>
              <div>
                <div style={{ fontWeight: 600, color: '#4ade80', fontSize: 13 }}>
                  {autoAcceptedCount} image{autoAcceptedCount !== 1 ? 's' : ''} auto-applied across {grouped.filter(g => g.acceptedImages.size > 0).length} GCPs
                </div>
                <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
                  {elapsed !== null && `Scanned in ${elapsed}s. `}Review below and reject anything that looks wrong.
                </div>
              </div>
            </div>

            <label style={{ ...styles.sectionLabel, marginTop: 16 }}>
              Results — {grouped.reduce((a, g) => a + g.hits.length, 0)} matches found
            </label>

            {grouped.map((group, groupIdx) => (
              <div key={group.gcpLabel} style={styles.resultGroup}>
                <div style={styles.resultGroupHeader}>
                  <strong style={{ color: '#e2e8f0' }}>{group.gcpLabel}</strong>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    {group.acceptedImages.size > 0 && (
                      <span style={styles.acceptedBadge}>✓ {group.acceptedImages.size} applied</span>
                    )}
                    {group.rejectedImages.size > 0 && (
                      <span style={styles.skippedBadge}>✕ {group.rejectedImages.size} rejected</span>
                    )}
                    {group.hits.length === 0 && (
                      <span style={styles.noHitBadge}>No match found</span>
                    )}
                  </div>
                </div>

                {group.hits.length > 0 && (
                  <div style={styles.hitsScroll}>
                    {group.hits.map((hit, hi) => {
                      const isAccepted = group.acceptedImages.has(hit.image_name);
                      const isRejected = group.rejectedImages.has(hit.image_name);
                      return (
                        <div key={hi} style={{
                          ...styles.hitCard,
                          ...(isAccepted ? { border: '1px solid rgba(74,222,128,0.35)', background: 'rgba(74,222,128,0.05)' } : {}),
                          ...(isRejected ? { opacity: 0.4, border: '1px solid rgba(239,68,68,0.2)' } : {}),
                        }}>
                          {/* Thumbnail */}
                          <div style={styles.thumbWrap}>
                            <img
                              src={thumbnailUrl(hit.image_name)}
                              alt={hit.image_name}
                              style={styles.thumb}
                              onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                            />
                            <div style={{
                              ...styles.crosshair,
                              left: `${(hit.pixel_x / 1000) * 100}%`,
                              top: `${(hit.pixel_y / 750) * 100}%`,
                            }} title={`Pixel: (${hit.pixel_x.toFixed(0)}, ${hit.pixel_y.toFixed(0)})`}>
                              ✛
                            </div>
                          </div>

                          {/* Info */}
                          <div style={styles.hitInfo}>
                            <div style={styles.hitFilename}>{hit.image_name}</div>
                            <div style={styles.hitMeta}>
                              <span>Pixel: ({hit.pixel_x.toFixed(0)}, {hit.pixel_y.toFixed(0)})</span>
                              <span style={{ color: confidenceColor(hit.confidence) }}>
                                {(hit.confidence * 100).toFixed(0)}% confidence
                              </span>
                              <span style={{ color: '#64748b' }}>{hit.candidates_scanned} scanned</span>
                            </div>
                            <div style={styles.hitActions}>
                              {isRejected ? (
                                <button
                                  id={`reaccept-${group.gcpLabel}-${hi}`}
                                  style={styles.reAcceptBtn}
                                  onClick={() => reAccept(groupIdx, hit)}
                                >
                                  ↩ Undo Reject
                                </button>
                              ) : isAccepted ? (
                                <>
                                  <span style={{ color: '#4ade80', fontSize: 12, fontWeight: 600 }}>✓ Applied</span>
                                  <button
                                    id={`reject-${group.gcpLabel}-${hi}`}
                                    style={styles.rejectBtn}
                                    onClick={() => reject(groupIdx, hit)}
                                  >
                                    ✕ Reject
                                  </button>
                                </>
                              ) : (
                                <button
                                  id={`reaccept-${group.gcpLabel}-${hi}`}
                                  style={styles.reAcceptBtn}
                                  onClick={() => reAccept(groupIdx, hit)}
                                >
                                  + Apply
                                </button>
                              )}
                              {hi === 0 && group.hits.length > 1 && (
                                <span style={styles.bestLabel}>Best match</span>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed', inset: 0,
    background: 'rgba(0,0,0,0.65)',
    backdropFilter: 'blur(6px)',
    display: 'flex', alignItems: 'flex-start', justifyContent: 'flex-end',
    zIndex: 1000,
    padding: '16px',
  },
  panel: {
    width: '620px', maxWidth: '100%',
    maxHeight: 'calc(100vh - 32px)',
    overflowY: 'auto',
    background: 'linear-gradient(160deg, rgba(15,23,42,0.98) 0%, rgba(23,33,55,0.98) 100%)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: '16px',
    boxShadow: '0 32px 80px rgba(0,0,0,0.6)',
    padding: '24px',
    display: 'flex', flexDirection: 'column', gap: '0px',
    scrollbarWidth: 'thin',
    scrollbarColor: 'rgba(100,116,139,0.4) transparent',
  },
  header: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
    marginBottom: '20px',
  },
  title: {
    margin: 0, fontSize: '20px', fontWeight: 700,
    color: '#f1f5f9',
    fontFamily: "'Inter', sans-serif",
  },
  subtitle: {
    margin: '4px 0 0', fontSize: '13px', color: '#64748b',
    fontFamily: "'Inter', sans-serif",
  },
  closeBtn: {
    background: 'none', border: '1px solid rgba(255,255,255,0.1)',
    color: '#94a3b8', cursor: 'pointer', borderRadius: '8px',
    padding: '6px 10px', fontSize: '14px',
    transition: 'all 0.2s',
  },
  section: {
    marginBottom: '20px',
  },
  sectionLabel: {
    display: 'block', fontSize: '11px', fontWeight: 600,
    color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.1em',
    marginBottom: '10px',
    fontFamily: "'Inter', sans-serif",
  },
  strategyGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px',
    marginBottom: '10px',
  },
  strategyCard: {
    position: 'relative',
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    gap: '4px', padding: '10px 8px',
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.07)',
    borderRadius: '10px', cursor: 'pointer',
    color: '#94a3b8', fontSize: '12px', fontWeight: 500,
    transition: 'all 0.2s',
    fontFamily: "'Inter', sans-serif",
  },
  strategyCardActive: {
    background: 'rgba(99,102,241,0.15)',
    border: '1px solid rgba(99,102,241,0.5)',
    color: '#a5b4fc',
    boxShadow: '0 0 12px rgba(99,102,241,0.2)',
  },
  strategyIcon: {
    fontSize: '22px', lineHeight: 1,
  },
  strategyLabel: {
    textAlign: 'center', lineHeight: 1.3,
  },
  badge: {
    position: 'absolute', top: '4px', right: '4px',
    background: 'rgba(99,102,241,0.3)', color: '#a5b4fc',
    fontSize: '9px', padding: '1px 5px', borderRadius: '4px',
    fontWeight: 600, letterSpacing: '0.05em',
  },
  strategyDesc: {
    fontSize: '12px', color: '#64748b', margin: 0, lineHeight: 1.5,
    fontFamily: "'Inter', sans-serif",
  },
  row: {
    display: 'flex', gap: '12px',
  },
  field: {
    flex: 1, display: 'flex', flexDirection: 'column', gap: '6px',
  },
  fieldLabel: {
    fontSize: '12px', color: '#94a3b8', fontWeight: 500,
    fontFamily: "'Inter', sans-serif",
  },
  input: {
    background: 'rgba(255,255,255,0.05)',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: '8px', padding: '8px 12px',
    color: '#e2e8f0', fontSize: '14px',
    fontFamily: "'Inter', sans-serif",
    outline: 'none',
    width: '100%', boxSizing: 'border-box',
  },
  select: {
    background: 'rgba(15,23,42,0.9)',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: '8px', padding: '8px 12px',
    color: '#e2e8f0', fontSize: '14px',
    fontFamily: "'Inter', sans-serif",
    outline: 'none', width: '100%',
  },
  hint: {
    fontSize: '12px', color: '#475569', margin: '8px 0 0',
    lineHeight: 1.5, fontFamily: "'Inter', sans-serif",
  },
  gcpChips: {
    display: 'flex', flexWrap: 'wrap', gap: '8px',
  },
  chip: {
    background: 'rgba(255,255,255,0.06)',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: '20px', padding: '4px 12px',
    fontSize: '12px', color: '#94a3b8',
    fontFamily: "'Inter', sans-serif",
  },
  runBtn: {
    width: '100%', padding: '14px',
    background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
    border: 'none', borderRadius: '10px',
    color: '#fff', fontSize: '15px', fontWeight: 600,
    cursor: 'pointer', display: 'flex', alignItems: 'center',
    justifyContent: 'center', gap: '8px',
    boxShadow: '0 4px 20px rgba(99,102,241,0.35)',
    transition: 'all 0.2s',
    fontFamily: "'Inter', sans-serif",
  },
  runBtnDisabled: {
    opacity: 0.5, cursor: 'not-allowed',
    boxShadow: 'none',
  },
  runningHint: {
    textAlign: 'center', fontSize: '12px', color: '#64748b',
    margin: '8px 0 0', fontFamily: "'Inter', sans-serif",
  },
  spinner: {
    display: 'inline-block',
    width: '14px', height: '14px',
    border: '2px solid rgba(255,255,255,0.3)',
    borderTopColor: '#fff',
    borderRadius: '50%',
    animation: 'spin 0.8s linear infinite',
  },
  errorBox: {
    background: 'rgba(239,68,68,0.1)',
    border: '1px solid rgba(239,68,68,0.3)',
    borderRadius: '10px', padding: '14px 16px',
    color: '#fca5a5', fontSize: '13px',
    marginBottom: '16px',
    fontFamily: "'Inter', sans-serif",
  },
  resultGroup: {
    marginBottom: '16px',
    background: 'rgba(255,255,255,0.03)',
    border: '1px solid rgba(255,255,255,0.06)',
    borderRadius: '10px', padding: '12px',
  },
  resultGroupHeader: {
    display: 'flex', alignItems: 'center', gap: '10px',
    marginBottom: '10px', fontSize: '13px',
    fontFamily: "'Inter', sans-serif",
  },
  acceptedBadge: {
    background: 'rgba(74,222,128,0.15)', color: '#4ade80',
    fontSize: '11px', padding: '2px 8px', borderRadius: '6px',
    fontWeight: 500,
  },
  skippedBadge: {
    background: 'rgba(100,116,139,0.15)', color: '#94a3b8',
    fontSize: '11px', padding: '2px 8px', borderRadius: '6px',
  },
  noHitBadge: {
    background: 'rgba(239,68,68,0.1)', color: '#f87171',
    fontSize: '11px', padding: '2px 8px', borderRadius: '6px',
  },
  successBanner: {
    display: 'flex', alignItems: 'flex-start', gap: 12,
    background: 'rgba(74,222,128,0.08)',
    border: '1px solid rgba(74,222,128,0.25)',
    borderRadius: 10, padding: '14px 16px',
  },
  rejectBtn: {
    padding: '4px 10px',
    background: 'rgba(239,68,68,0.1)',
    border: '1px solid rgba(239,68,68,0.25)',
    borderRadius: '6px', color: '#f87171',
    fontSize: '11px', fontWeight: 600, cursor: 'pointer',
    fontFamily: "'Inter', sans-serif",
    transition: 'all 0.15s',
  },
  reAcceptBtn: {
    padding: '4px 10px',
    background: 'rgba(99,102,241,0.1)',
    border: '1px solid rgba(99,102,241,0.25)',
    borderRadius: '6px', color: '#a5b4fc',
    fontSize: '11px', fontWeight: 600, cursor: 'pointer',
    fontFamily: "'Inter', sans-serif",
    transition: 'all 0.15s',
  },
  hitsScroll: {
    display: 'flex', flexDirection: 'column', gap: '10px',
  },
  hitCard: {
    display: 'flex', gap: '12px', alignItems: 'flex-start',
    background: 'rgba(255,255,255,0.03)',
    border: '1px solid rgba(255,255,255,0.06)',
    borderRadius: '8px', padding: '10px',
  },
  thumbWrap: {
    position: 'relative', flexShrink: 0,
    width: '120px', height: '90px',
    background: '#0f172a', borderRadius: '6px', overflow: 'hidden',
  },
  thumb: {
    width: '100%', height: '100%', objectFit: 'cover',
  },
  crosshair: {
    position: 'absolute',
    transform: 'translate(-50%, -50%)',
    color: '#f59e0b',
    fontSize: '18px', fontWeight: 900, lineHeight: 1,
    textShadow: '0 0 4px rgba(0,0,0,0.9)',
    pointerEvents: 'none',
  },
  hitInfo: {
    flex: 1, display: 'flex', flexDirection: 'column', gap: '6px',
  },
  hitFilename: {
    fontSize: '12px', color: '#94a3b8', fontWeight: 500,
    wordBreak: 'break-all',
    fontFamily: "'Inter', sans-serif",
  },
  hitMeta: {
    display: 'flex', flexWrap: 'wrap', gap: '10px',
    fontSize: '11px', color: '#64748b',
    fontFamily: "'Inter', sans-serif",
  },
  hitActions: {
    display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px',
  },
  bestLabel: {
    fontSize: '10px', color: '#6366f1', fontWeight: 600,
    background: 'rgba(99,102,241,0.1)',
    padding: '2px 8px', borderRadius: '4px',
    fontFamily: "'Inter', sans-serif",
  },
  colorGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px',
    marginBottom: '8px',
  },
  colorSwatch: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '5px',
    padding: '8px 6px',
    background: 'rgba(255,255,255,0.04)',
    borderRadius: '8px', cursor: 'pointer',
    transition: 'all 0.15s',
  },
  swatchDot: {
    display: 'inline-block',
    width: '22px', height: '22px',
    borderRadius: '50%',
    boxShadow: '0 0 6px rgba(0,0,0,0.5)',
  },
};

// Inject keyframe for spinner
if (typeof document !== 'undefined') {
  const styleEl = document.getElementById('gcp-detect-styles') ?? document.createElement('style');
  styleEl.id = 'gcp-detect-styles';
  styleEl.textContent = `@keyframes spin { to { transform: rotate(360deg); } }`;
  if (!document.getElementById('gcp-detect-styles')) document.head.appendChild(styleEl);
}
