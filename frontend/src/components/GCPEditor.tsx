/**
 * GCPEditor — full Ground Control Point editor.
 * Supports manual entry, CSV import, and links GCPs to images.
 * Reads/saves via projectsApi.saveGCPs / projectsApi.getGCPs.
 */

import { useState, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { projectsApi, type GCPPoint } from '../api';
import { useToast } from '../hooks/useToast';

interface Props { projectId: string; gcpCount: number; }

const EMPTY_GCP: Omit<GCPPoint, 'id'> = { label: '', x: 0, y: 0, z: 0 };

function parseCSV(text: string): GCPPoint[] {
  const lines = text.trim().split('\n').filter(l => l.trim() && !l.startsWith('#'));
  const gcps: GCPPoint[] = [];

  for (const line of lines) {
    const parts = line.split(/[\t,\s]+/).map(p => p.trim());
    // Formats: label x y z  OR  x y z label  OR  label lon lat alt
    if (parts.length < 4) continue;
    const hasLabel = isNaN(Number(parts[0]));
    const [label, a, b, c] = hasLabel
      ? [parts[0], parts[1], parts[2], parts[3]]
      : [parts[3], parts[0], parts[1], parts[2]];
    if (!label || isNaN(Number(a))) continue;
    gcps.push({ label, x: Number(a), y: Number(b), z: Number(c) });
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
  gcp, index, onChange, onDelete, readOnly,
}: {
  gcp: GCPPoint; index: number;
  onChange: (i: number, field: keyof GCPPoint, val: string | number) => void;
  onDelete: (i: number) => void;
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

  const { data: saved = [], isLoading } = useQuery<GCPPoint[]>({
    queryKey: ['gcps', projectId],
    queryFn:  () => projectsApi.getGCPs(projectId),
  });

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
    </div>
  );
}
