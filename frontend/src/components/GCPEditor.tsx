/**
 * GCPEditor — full Ground Control Point editor.
 * Supports manual entry, CSV import, and links GCPs to images.
 * Reads/saves via projectsApi.saveGCPs / projectsApi.getGCPs.
 */

import { useState, useRef, useMemo } from 'react';
import GCPImagePicker from './GCPImagePicker';
import GCPPhotoOrganizer from './GCPPhotoOrganizer';
import GcpAutoDetect from './GcpAutoDetect';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { projectsApi, type GCPPoint } from '../api';
import { useToast } from '../hooks/useToast';
import proj4 from 'proj4';

interface Props { projectId: string; gcpCount: number; }

const EMPTY_GCP: Omit<GCPPoint, 'id'> = { label: '', x: 0, y: 0, z: 0, observations: [] };

function parseCSV(text: string): GCPPoint[] {
  const lines = text.trim().split('\n').filter(l => l.trim() && !l.startsWith('#'));
  const gcps: GCPPoint[] = [];

  const looksLikePointId = (v: string) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 && n <= 99999;
  };
  const looksLikeCoord = (v: string) => {
    const n = Number(v);
    return isFinite(n) && Math.abs(n) > 5000;
  };

  for (const line of lines) {
    const parts = line.split(/[\t,\s]+/).map(p => p.trim());
    if (parts.length < 4) continue;

    // Format detection:
    // 1) Non-numeric first field  → always label,x,y,z
    // 2) Numeric label at start   → label,x,y,z  (survey format: 1005  1777368  1666716  5672)
    //    Detected when: first value is a small integer AND at least one of 2nd/3rd values is a large coord
    // 3) Otherwise               → x,y,z,label  (ODM format: lon lat alt label)
    let label: string, a: string, b: string, c: string;
    if (isNaN(Number(parts[0])) || (looksLikePointId(parts[0]) && (looksLikeCoord(parts[1]) || looksLikeCoord(parts[2])))) {
      [label, a, b, c] = [parts[0], parts[1], parts[2], parts[3]];
    } else {
      [label, a, b, c] = [parts[3], parts[0], parts[1], parts[2]];
    }
    if (!label || isNaN(Number(a))) continue;
    gcps.push({ label, x: Number(a), y: Number(b), z: Number(c), observations: [] });
  }
  return gcps;
}

function rmseColor(v?: number): string {
  if (v == null) return 'var(--text-muted)';
  if (v < 0.03) return 'var(--success)';
  if (v < 0.08) return 'var(--warning)';
  return 'var(--error)';
}

function fmtErr(v?: number): string {
  if (v == null) return '—';
  return `${(v * 100).toFixed(1)} cm`;
}

// ─── Row editor ───────────────────────────────────────────────────────────────

function GCPRow({
  gcp, index, onChange, onDelete, onPick, readOnly,
}: {
  gcp: GCPPoint; index: number;
  onChange: (i: number, field: keyof GCPPoint, val: string | number) => void;
  onDelete: (i: number) => void;
  onPick: (i: number) => void;
  readOnly: boolean;
}) {
  const hasError = gcp.error_total != null;
  return (
    <tr style={{ opacity: readOnly ? 0.7 : 1 }}>
      <td>
        <input
          className="input"
          style={{ width: 100, padding: '4px 8px', fontSize: 12 }}
          value={gcp.label} disabled={readOnly}
          onChange={e => onChange(index, 'label', e.target.value)}
          placeholder="GCP-01"
        />
      </td>
      {(['x','y','z'] as const).map(field => (
        <td key={field}>
          <input
            className="input font-mono"
            style={{ width: 120, padding: '4px 8px', fontSize: 12 }}
            type="number" step="any"
            value={gcp[field] as number} disabled={readOnly}
            onChange={e => onChange(index, field, Number(e.target.value))}
          />
        </td>
      ))}
      <td>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {gcp.observations.length === 0 ? (
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>—</span>
          ) : (
            <span style={{ fontSize: 11, color: 'var(--success)' }}>
              {gcp.observations.length} image{gcp.observations.length > 1 ? 's' : ''}
            </span>
          )}
          {!readOnly && (
            <button
              className="btn btn-primary btn-sm"
              style={{ padding: '2px 8px', fontSize: 10, height: 22 }}
              onClick={() => onPick(index)}
            >📷 Pick</button>
          )}
        </div>
      </td>
      <td style={{ fontSize: 11, fontFamily: 'monospace', color: rmseColor(gcp.error_x) }}>
        {hasError ? fmtErr(gcp.error_x) : '—'}
      </td>
      <td style={{ fontSize: 11, fontFamily: 'monospace', color: rmseColor(gcp.error_y) }}>
        {hasError ? fmtErr(gcp.error_y) : '—'}
      </td>
      <td style={{ fontSize: 11, fontFamily: 'monospace', color: rmseColor(gcp.error_z) }}>
        {hasError ? fmtErr(gcp.error_z) : '—'}
      </td>
      <td>
        {hasError && (
          <span style={{
            fontSize: 10, padding: '2px 6px', borderRadius: 99,
            fontWeight: 700,
            background: gcp.error_total! < 0.03 ? 'rgba(34,197,94,0.15)' : gcp.error_total! < 0.08 ? 'rgba(245,158,11,0.15)' : 'rgba(239,68,68,0.15)',
            color: rmseColor(gcp.error_total),
          }}>
            {gcp.error_total! < 0.03 ? 'Excellent' : gcp.error_total! < 0.08 ? 'OK' : 'Review'}
          </span>
        )}
      </td>
      <td>
        {!readOnly && (
          <button
            className="btn btn-ghost btn-sm"
            style={{ color: 'var(--error)', padding: '2px 8px' }}
            onClick={() => onDelete(index)}
          >✕</button>
        )}
      </td>
    </tr>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function GCPEditor({ projectId }: Props) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<GCPPoint[]>([]);
  const [pickingFor, setPickingFor] = useState<number | null>(null);
  const [showOrganizer, setShowOrganizer] = useState(false);
  const [showAutoDetect, setShowAutoDetect] = useState(false);

  const { data: saved = [], isLoading } = useQuery<GCPPoint[]>({
    queryKey: ['gcps', projectId],
    queryFn:  () => projectsApi.getGCPs(projectId),
  });

  // Also fetch the project so we know its coordinate system for auto-detect
  const { data: project } = useQuery<any>({
    queryKey: ['project', projectId],
    queryFn:  () => projectsApi.get(projectId),
  });

  // Build lat/lon coords for auto-detect (same proj4 logic as NewProject wizard)
  // Survey convention: X=Northing, Y=Easting → pass [y, x] to proj4
  const gcpCoords = useMemo(() => {
    const coordSys = project?.coordinate_system ?? 'EPSG:4326';
    const map: Record<string, { lat: number; lon: number }> = {};
    for (const g of saved) {
      if (g.x === 0 && g.y === 0) continue;
      if (coordSys === 'EPSG:4326') {
        map[g.label] = { lat: g.y, lon: g.x };
      } else {
        try {
          const [lon, lat] = proj4(coordSys, 'EPSG:4326', [g.y, g.x]);
          if (isFinite(lat) && isFinite(lon)) map[g.label] = { lat, lon };
        } catch { /* unknown projection */ }
      }
    }
    return map;
  }, [saved, project]);

  const saveMutation = useMutation({
    mutationFn: (gcps: GCPPoint[]) => projectsApi.saveGCPs(projectId, gcps),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['gcps', projectId] });
      qc.invalidateQueries({ queryKey: ['project', projectId] });
      setEditing(false);
      toast.success('GCPs saved', `${draft.length} control points saved`);
    },
    onError: (e: any) => toast.error('Save failed', e?.message),
  });

  const startEdit = () => {
    setDraft(saved.map(g => ({ ...g })));
    setEditing(true);
  };

  const cancel = () => {
    setDraft([]);
    setEditing(false);
  };

  const addRow = () => setDraft(prev => [...prev, { ...EMPTY_GCP, label: `GCP-${String(prev.length + 1).padStart(2,'0')}` }]);

  const changeRow = (i: number, field: keyof GCPPoint, val: string | number) => {
    setDraft(prev => prev.map((g, idx) => idx === i ? { ...g, [field]: val } : g));
  };

  const deleteRow = (i: number) => {
    setDraft(prev => prev.filter((_, idx) => idx !== i));
  };

  const importCSV = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const gcps = parseCSV(ev.target?.result as string);
      if (gcps.length === 0) {
        toast.error('CSV parse failed', 'No valid GCP rows found. Expected: label x y z');
        return;
      }
      setDraft(gcps);
      if (!editing) setEditing(true);
      toast.success(`Imported ${gcps.length} GCPs`, 'Review and save when ready');
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  // Detect when columns got saved in wrong order (survey IDs treated as ODM label-at-end)
  // Symptom: labels look like elevations (small decimals, e.g. 5672.4472) and x values
  // look like point numbers (small integers, e.g. 1005)
  const columnsLookSwapped = draft.length > 0
    && draft.every(g => {
      const labelNum = parseFloat(g.label);
      return !isNaN(labelNum) && labelNum > 0 && labelNum < 9999
        && g.label.includes('.')          // label has decimals → looks like elevation
        && Number.isInteger(g.x) && g.x > 0 && g.x < 9999; // x is small integer → looks like point ID
    });

  const repairColumnOrder = () => {
    // Inverse of the bad parse: [label=elev, x=id, y=easting, z=northing]
    // → correct:              [label=id,   x=easting, y=northing, z=elev]
    setDraft(prev => prev.map(g => ({
      ...g,
      label: String(g.x),
      x: g.y,
      y: g.z,
      z: parseFloat(g.label),
    })));
    toast.success('Columns repaired', 'Review values, then click Save');
  };

  const display = editing ? draft : saved;
  const hasAccuracy = display.some(g => g.error_total != null);

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3>Ground Control Points</h3>
          {!isLoading && (
            <div className="text-xs text-muted mt-1">
              {saved.length} point{saved.length !== 1 ? 's' : ''} saved
              {hasAccuracy && ' · accuracy computed'}
            </div>
          )}
        </div>
        <div className="flex gap-2">
          {!editing && (
            <>
              <input
                ref={fileRef} type="file" accept=".csv,.txt" style={{ display: 'none' }}
                onChange={importCSV}
              />
              <button className="btn btn-ghost btn-sm" onClick={() => fileRef.current?.click()}>
                ↑ Import CSV
              </button>
              {saved.length > 0 && (
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => setShowAutoDetect(true)}
                  title="Auto-detect GCP targets in aerial photos"
                >
                  🎯 Auto-Detect
                </button>
              )}
              {saved.length > 0 && (
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => setShowOrganizer(true)}
                  title="View all photos grouped by proximity to each GCP"
                >
                  📸 Organize Photos
                </button>
              )}
              <button className="btn btn-secondary btn-sm" onClick={startEdit}>
                {saved.length > 0 ? '✏ Edit' : '＋ Add GCPs'}
              </button>
            </>
          )}
          {editing && (
            <>
              <button className="btn btn-ghost btn-sm" onClick={cancel}>Cancel</button>
              <button className="btn btn-ghost btn-sm" onClick={addRow}>＋ Row</button>
              <button
                className="btn btn-primary btn-sm"
                disabled={saveMutation.isPending || draft.some(g => !g.label.trim())}
                onClick={() => saveMutation.mutate(draft)}
              >
                {saveMutation.isPending ? '⟳ Saving…' : '✓ Save'}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Column-swap repair banner */}
      {editing && columnsLookSwapped && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.35)',
          borderRadius: 8, padding: '10px 14px', marginBottom: 12, gap: 12,
        }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--warning)' }}>
              ⚠ Column order looks wrong
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
              Labels appear to be elevations and X values look like point numbers.
              This happens when a survey CSV with numeric IDs is imported.
            </div>
          </div>
          <button
            className="btn btn-sm"
            style={{ background: 'var(--warning)', color: '#000', fontWeight: 600, flexShrink: 0 }}
            onClick={repairColumnOrder}
          >
            🔧 Repair Columns
          </button>
        </div>
      )}

      {/* CSV format hint */}
      {editing && (
        <div style={{
          fontSize: 11, color: 'var(--text-muted)', background: 'var(--bg-elevated)',
          borderRadius: 8, padding: '8px 12px', marginBottom: 12,
        }}>
          <strong style={{ color: 'var(--text-secondary)' }}>CSV format:</strong>
          {' '}label,easting,northing,elevation &nbsp;·&nbsp; or &nbsp;·&nbsp; label,longitude,latitude,altitude
        </div>
      )}

      {/* GCP table */}
      {isLoading ? (
        <div className="skeleton skeleton-card" style={{ height: 80 }} />
      ) : display.length === 0 ? (
        <div className="empty-state" style={{ padding: '32px 16px' }}>
          <div className="empty-state-icon" style={{ fontSize: 36 }}>📍</div>
          <p style={{ fontSize: 13 }}>No GCPs defined. Add them manually or import a CSV file.</p>
          <p className="text-xs text-muted">GCPs improve absolute accuracy from ~3 m to &lt;5 cm.</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Label</th>
                <th>Easting / X</th>
                <th>Northing / Y</th>
                <th>Elevation / Z</th>
                <th>Image</th>
                <th>Err X</th>
                <th>Err Y</th>
                <th>Err Z</th>
                <th>Rating</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {display.map((g, i) => (
                <GCPRow
                  key={g.id ?? i}
                  gcp={g} index={i}
                  onChange={changeRow} onDelete={deleteRow}
                  onPick={(idx) => setPickingFor(idx)}
                  readOnly={!editing}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* RMSE summary (post-processing) */}
      {!editing && hasAccuracy && (
        <div style={{ marginTop: 16, display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8 }}>
          {['X','Y','Z'].map(axis => {
            const errs = display.map(g => g[`error_${axis.toLowerCase()}` as keyof GCPPoint] as number | undefined).filter((v): v is number => v != null);
            const rmse = errs.length > 0 ? Math.sqrt(errs.reduce((a,b) => a + b*b, 0) / errs.length) : null;
            return (
              <div key={axis} style={{
                background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                borderRadius: 8, padding: '10px 14px', textAlign: 'center',
              }}>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4, textTransform: 'uppercase' }}>
                  RMSE {axis}
                </div>
                <div style={{ fontSize: 18, fontWeight: 700, color: rmseColor(rmse ?? undefined), fontFamily: 'monospace' }}>
                  {fmtErr(rmse ?? undefined)}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {pickingFor !== null && (
        <GCPImagePicker
          projectId={projectId}
          gcpX={draft[pickingFor]?.x}
          gcpY={draft[pickingFor]?.y}
          gcpLabel={draft[pickingFor]?.label}
          onSelect={(imageName, pixelX, pixelY) => {
            setDraft(prev => prev.map((g, idx) =>
              idx === pickingFor
                ? { ...g, observations: [...g.observations, { image: imageName, pixel_x: pixelX, pixel_y: pixelY }] }
                : g
            ));
            setPickingFor(null);
          }}
          onClose={() => setPickingFor(null)}
        />
      )}

      {showOrganizer && (
        <GCPPhotoOrganizer
          projectId={projectId}
          gcps={saved}
          onAssign={(gcpLabel, imageName, pixelX, pixelY) => {
            const updated = saved.map((g) =>
              g.label === gcpLabel
                ? { ...g, observations: [...g.observations, { image: imageName, pixel_x: pixelX, pixel_y: pixelY }] }
                : g
            );
            saveMutation.mutate(updated);
          }}
          onClose={() => setShowOrganizer(false)}
        />
      )}

      {showAutoDetect && (
        <GcpAutoDetect
          projectId={projectId}
          gcps={saved}
          gcpCoords={gcpCoords}
          onAccept={(gcpLabel, imageName, pixelX, pixelY) => {
            const updated = saved.map((g) =>
              g.label === gcpLabel
                ? { ...g, observations: [...g.observations, { image: imageName, pixel_x: pixelX, pixel_y: pixelY }] }
                : g
            );
            saveMutation.mutate(updated);
          }}
          onReject={(gcpLabel, imageName) => {
            const updated = saved.map((g) =>
              g.label === gcpLabel
                ? { ...g, observations: g.observations.filter(o => o.image !== imageName) }
                : g
            );
            saveMutation.mutate(updated);
          }}
          onClose={() => setShowAutoDetect(false)}
        />
      )}
    </div>
  );
}
