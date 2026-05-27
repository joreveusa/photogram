import React, { useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { projectsApi, jobsApi, type GCPPoint, type ProcessingPreset, type ExifSummary } from '../api';

// ─── Preset Picker ────────────────────────────────────────────────────────────

const PRESETS: Array<{
  id: ProcessingPreset;
  icon: string;
  name: string;
  desc: string;
  time: string;
  odm: Record<string, string | number | boolean>;
}> = [
  {
    id: 'fast_preview',
    icon: '⚡', name: 'Fast Preview',
    desc: 'Low-res orthomosaic, skip 3D mesh. Great for field QC.',
    time: '~15 min / 100 imgs',
    odm: { 'fast-orthophoto': true, 'skip-3dmodel': true, 'pc-quality': 'low', 'min-num-features': 4000 },
  },
  {
    id: 'survey_grade',
    icon: '🎯', name: 'Survey Grade',
    desc: 'Balanced quality + speed. Recommended for most projects.',
    time: '~1 hr / 100 imgs',
    odm: { 'pc-quality': 'medium', 'min-num-features': 8000, 'mesh-size': 200000 },
  },
  {
    id: 'high_fidelity',
    icon: '💎', name: 'High Fidelity',
    desc: 'Maximum quality. Ultra dense cloud + full 3D mesh.',
    time: '~3 hr / 100 imgs',
    odm: { 'pc-quality': 'ultra', 'min-num-features': 16000, 'mesh-size': 500000, '3d-tiles': true },
  },
];

// ─── ODM Option catalog ──────────────────────────────────────────────────────

interface OdmOption {
  name: string;
  label: string;
  type: 'select' | 'number' | 'toggle';
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
  hint: string;
  group: string;
}

const ODM_OPTIONS: OdmOption[] = [
  // Quality
  { name: 'pc-quality',         label: 'Point Cloud Quality',   type: 'select',  options: ['lowest','low','medium','high','ultra'],  hint: 'Higher = denser cloud + more RAM', group: 'Quality' },
  { name: 'min-num-features',   label: 'Min Features',          type: 'number',  min: 1000, max: 32000, step: 1000,                   hint: 'More features = better tie points, slower SfM', group: 'Quality' },
  { name: 'mesh-size',          label: 'Mesh Resolution',       type: 'number',  min: 50000, max: 1000000, step: 50000,               hint: 'Vertices in the 3D mesh', group: 'Quality' },
  // Speed
  { name: 'fast-orthophoto',    label: 'Fast Orthophoto',       type: 'toggle',                                                        hint: 'Skip full 3D reconstruction, build ortho directly from 2.5D', group: 'Speed' },
  { name: 'skip-3dmodel',       label: 'Skip 3D Model',         type: 'toggle',                                                        hint: 'Do not generate mesh or textures', group: 'Speed' },
  { name: 'orthophoto-resolution', label: 'Ortho Resolution (cm/px)', type: 'number', min: 1, max: 20, step: 0.5,                     hint: 'Lower = higher resolution', group: 'Speed' },
  // Output
  { name: '3d-tiles',           label: '3D Tiles Output',       type: 'toggle',                                                        hint: 'Generate Cesium 3D Tiles for web streaming', group: 'Output' },
  { name: 'dtm',                label: 'Generate DTM',          type: 'toggle',                                                        hint: 'Bare-earth Digital Terrain Model in addition to DSM', group: 'Output' },
  { name: 'cog',                label: 'Cloud-Optimised GeoTIFF', type: 'toggle',                                                      hint: 'Orthomosaic as COG for efficient remote access', group: 'Output' },
  // SfM
  { name: 'matcher-neighbors',  label: 'Matcher Neighbors',     type: 'number',  min: 4, max: 48, step: 2,                             hint: 'How many neighbors to match each image against', group: 'SfM' },
  { name: 'feature-type',       label: 'Feature Type',          type: 'select',  options: ['akaze','sift','orb','hahog','dspsift'],     hint: 'SIFT is most robust; AKAZE is faster', group: 'SfM' },
];

// ─── Advanced Options Editor ──────────────────────────────────────────────────

function AdvancedOptions({
  overrides,
  onChange,
  basePreset,
}: {
  overrides: Record<string, string | number | boolean>;
  onChange: (o: Record<string, string | number | boolean>) => void;
  basePreset: ProcessingPreset;
}) {
  const [open, setOpen] = useState(false);
  const preset = PRESETS.find(p => p.id === basePreset)!;

  const groups = Array.from(new Set(ODM_OPTIONS.map(o => o.group)));

  const getVal = (opt: OdmOption) =>
    opt.name in overrides ? overrides[opt.name] : preset.odm[opt.name] ?? '';

  const set = (name: string, val: string | number | boolean) => {
    const base = preset.odm[name];
    const next = { ...overrides };
    if (val === base || val === '') {
      delete next[name];
    } else {
      next[name] = val;
    }
    onChange(next);
  };

  const overrideCount = Object.keys(overrides).length;

  return (
    <div className="mt-4">
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', justifyContent: 'space-between' }}
        onClick={() => setOpen(v => !v)}
      >
        <span>
          ⚙️ Advanced ODM Options
          {overrideCount > 0 && (
            <span style={{
              marginLeft: 8, background: 'var(--accent)', color: '#000',
              borderRadius: 99, fontSize: 10, fontWeight: 700, padding: '1px 7px',
            }}>{overrideCount} override{overrideCount !== 1 ? 's' : ''}</span>
          )}
        </span>
        <span style={{ opacity: 0.5 }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="card mt-2" style={{ padding: 16, borderColor: 'rgba(0,212,170,0.2)' }}>
          <div className="text-xs text-muted mb-3">
            Options override the <span style={{ color: 'var(--accent)' }}>{preset.name}</span> preset defaults shown in grey.
            Clear a field to restore the preset default.
          </div>

          {groups.map(group => (
            <div key={group} className="mb-4">
              <div style={{
                fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em',
                color: 'var(--text-muted)', marginBottom: 10,
                paddingBottom: 6, borderBottom: '1px solid var(--border)',
              }}>{group}</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 16px' }}>
                {ODM_OPTIONS.filter(o => o.group === group).map(opt => {
                  const v = getVal(opt);
                  const isOverride = opt.name in overrides;

                  return (
                    <div key={opt.name} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <label style={{
                        fontSize: 11, color: isOverride ? 'var(--accent)' : 'var(--text-secondary)',
                        fontWeight: isOverride ? 600 : 400,
                      }}>
                        {opt.label} {isOverride && '●'}
                      </label>

                      {opt.type === 'toggle' ? (
                        <div
                          onClick={() => set(opt.name, !v)}
                          style={{
                            display: 'inline-flex', alignItems: 'center', gap: 8,
                            cursor: 'pointer',
                          }}
                        >
                          <div style={{
                            width: 36, height: 20, borderRadius: 99,
                            background: v ? 'var(--accent)' : 'var(--bg-elevated)',
                            border: `1px solid ${v ? 'var(--accent)' : 'var(--border)'}`,
                            position: 'relative', transition: 'background 0.2s',
                          }}>
                            <div style={{
                              position: 'absolute', top: 2, left: v ? 18 : 2,
                              width: 14, height: 14, borderRadius: '50%',
                              background: v ? '#000' : 'var(--text-muted)',
                              transition: 'left 0.2s',
                            }} />
                          </div>
                          <span style={{ fontSize: 11, color: v ? 'var(--accent)' : 'var(--text-muted)' }}>
                            {v ? 'On' : 'Off'}
                          </span>
                        </div>
                      ) : opt.type === 'select' ? (
                        <select
                          className="select"
                          style={{ fontSize: 12, padding: '5px 8px', height: 30 }}
                          value={String(v)}
                          onChange={e => set(opt.name, e.target.value)}
                        >
                          <option value="">— preset default —</option>
                          {opt.options!.map(o => <option key={o} value={o}>{o}</option>)}
                        </select>
                      ) : (
                        <input
                          type="number"
                          className="input"
                          style={{ fontSize: 12, padding: '5px 8px', height: 30 }}
                          min={opt.min} max={opt.max} step={opt.step}
                          value={v === '' ? '' : Number(v)}
                          placeholder={String(preset.odm[opt.name] ?? '—')}
                          onChange={e => set(opt.name, e.target.value === '' ? '' : Number(e.target.value))}
                        />
                      )}
                      <div style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.4 }}>{opt.hint}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          {overrideCount > 0 && (
            <button type="button" className="btn btn-ghost btn-sm text-error mt-2"
              onClick={() => onChange({})}>
              ✕ Reset all overrides
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── RTK Config Panel ─────────────────────────────────────────────────────────

function RtkConfigPanel({
  mode, accH, accV, onMode, onAccH, onAccV,
}: {
  mode: string; accH: string; accV: string;
  onMode: (v: string) => void;
  onAccH: (v: string) => void;
  onAccV: (v: string) => void;
}) {
  return (
    <div className="card" style={{ marginTop: 16, borderColor: mode !== 'none' ? 'rgba(0,212,170,0.25)' : 'var(--border)' }}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span style={{ fontSize: 18 }}>📡</span>
          <h3>GPS / RTK Accuracy</h3>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {['none', 'rtk', 'ppk'].map(m => (
            <button
              key={m}
              type="button"
              className={`btn btn-sm ${mode === m ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => onMode(m)}
            >
              {m === 'none' ? 'Standard GPS' : m.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {mode === 'none' && (
        <p className="text-xs text-muted">
          OpenDroneMap will estimate GPS accuracy from EXIF data. Works well for consumer drones
          without RTK correction.
        </p>
      )}

      {(mode === 'rtk' || mode === 'ppk') && (
        <>
          <p className="text-xs text-muted mb-3">
            {mode === 'rtk'
              ? 'Real-Time Kinematic — corrections applied in-flight. Typical accuracy: 1–3 cm H, 2–5 cm V.'
              : 'Post-Processed Kinematic — corrections applied after the flight using base station data. Best accuracy.'}
          </p>
          <div className="input-row">
            <div className="form-group">
              <label>Horizontal Accuracy (m)</label>
              <input
                type="number" step="0.001" min="0.001" max="10"
                className="input font-mono"
                placeholder="e.g. 0.03"
                value={accH}
                onChange={e => onAccH(e.target.value)}
              />
              <div className="text-xs text-muted mt-1">e.g. 0.03 m for RTK fix</div>
            </div>
            <div className="form-group">
              <label>Vertical Accuracy (m)</label>
              <input
                type="number" step="0.001" min="0.001" max="10"
                className="input font-mono"
                placeholder="e.g. 0.05"
                value={accV}
                onChange={e => onAccV(e.target.value)}
              />
              <div className="text-xs text-muted mt-1">Typically 1.5–2× horizontal</div>
            </div>
          </div>
          <div className="text-xs" style={{
            padding: '8px 12px', borderRadius: 8,
            background: 'var(--accent-subtle)', color: 'var(--accent)', marginTop: 4,
          }}>
            💡 These values tell ODM how much to trust the EXIF GPS tags vs. GCP ground control.
            Tighter accuracy = GCP correction weighted less aggressively.
          </div>
        </>
      )}
    </div>
  );
}

// ─── GCP Editor ──────────────────────────────────────────────────────────────

function GCPEditor({ gcps, onChange }: { gcps: GCPPoint[]; onChange: (g: GCPPoint[]) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);

  const addRow = () => {
    onChange([...gcps, { label: `GCP${gcps.length + 1}`, x: 0, y: 0, z: 0 }]);
  };

  const updateRow = (i: number, field: keyof GCPPoint, val: string) => {
    const updated = [...gcps];
    (updated[i] as any)[field] = ['x', 'y', 'z', 'pixel_x', 'pixel_y'].includes(field as string)
      ? parseFloat(val) || 0
      : val;
    onChange(updated);
  };

  const removeRow = (i: number) => {
    onChange(gcps.filter((_, idx) => idx !== i));
  };

  const importCSV = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const text = ev.target?.result as string;
      const lines = text.trim().split('\n').filter(l => l.trim() && !l.startsWith('#'));
      const parsed: GCPPoint[] = lines.map(l => {
        const [label, x, y, z, px, py, img] = l.split(/[\t,;]+/).map(s => s.trim());
        return {
          label: label || '',
          x: parseFloat(x) || 0,
          y: parseFloat(y) || 0,
          z: parseFloat(z) || 0,
          pixel_x: px ? parseFloat(px) : undefined,
          pixel_y: py ? parseFloat(py) : undefined,
          image_name: img || undefined,
        };
      }).filter(g => g.label);
      if (parsed.length > 0) onChange([...gcps, ...parsed]);
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          {gcps.length === 0
            ? 'No GCPs added yet. GCPs improve absolute accuracy.'
            : `${gcps.length} GCP${gcps.length > 1 ? 's' : ''} defined`}
        </div>
        <div className="flex gap-2">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => fileRef.current?.click()}>
            📂 Import CSV
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={addRow}>
            + Add GCP
          </button>
          <input ref={fileRef} type="file" accept=".csv,.txt" onChange={importCSV} style={{ display: 'none' }} />
        </div>
      </div>

      {gcps.length > 0 && (
        <div className="table-wrap" style={{ marginTop: 8 }}>
          <table>
            <thead>
              <tr>
                <th>Label</th>
                <th>X (Easting)</th>
                <th>Y (Northing)</th>
                <th>Z (Elev.)</th>
                <th>Pixel X</th>
                <th>Pixel Y</th>
                <th>Image</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {gcps.map((g, i) => (
                <tr key={i}>
                  {(['label', 'x', 'y', 'z', 'pixel_x', 'pixel_y', 'image_name'] as (keyof GCPPoint)[]).map(f => (
                    <td key={f}>
                      <input
                        className="input"
                        style={{ fontSize: 12, padding: '4px 8px' }}
                        type={['x','y','z','pixel_x','pixel_y'].includes(f as string) ? 'number' : 'text'}
                        value={(g[f] as string | number) ?? ''}
                        onChange={e => updateRow(i, f, e.target.value)}
                      />
                    </td>
                  ))}
                  <td>
                    <button type="button" className="btn btn-ghost btn-sm text-error" onClick={() => removeRow(i)}>✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Image dropzone ───────────────────────────────────────────────────────────

interface UploadState {
  count: number;
  uploading: boolean;
  summary: ExifSummary | null;
  error: string | null;
}

// ─── Step definitions ─────────────────────────────────────────────────────────

const STEPS = [
  { id: 'details',  label: 'Project Details', icon: '📋' },
  { id: 'images',   label: 'Upload Images',   icon: '📷' },
  { id: 'rtk',      label: 'GPS & RTK',       icon: '📡' },
  { id: 'preset',   label: 'Processing',      icon: '⚙️' },
  { id: 'gcps',     label: 'GCPs',            icon: '📍' },
];

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function NewProject() {
  const navigate = useNavigate();

  // Project
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [coordSys, setCoordSys] = useState('EPSG:4326');

  // Images
  const [projectId, setProjectId] = useState<string | null>(null);
  const [uploadState, setUploadState] = useState<UploadState>({ count: 0, uploading: false, summary: null, error: null });
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // RTK
  const [rtkMode, setRtkMode] = useState<string>('none');
  const [rtkAccH, setRtkAccH] = useState('');
  const [rtkAccV, setRtkAccV] = useState('');

  // Auto-populate RTK from EXIF summary
  const applyExifRtk = (summary: ExifSummary) => {
    if (summary.avg_acc_h) {
      setRtkAccH(String(summary.avg_acc_h));
      setRtkAccV(String(summary.avg_acc_v ?? summary.avg_acc_h * 1.5));
    }
    if ((summary.rtk_fix_pct || 0) > 60) setRtkMode('rtk');
  };

  // Preset + advanced
  const [preset, setPreset] = useState<ProcessingPreset>('survey_grade');
  const [customOverrides, setCustomOverrides] = useState<Record<string, string | number | boolean>>({});

  // GCPs
  const [gcps, setGcps] = useState<GCPPoint[]>([]);

  // Submission
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Create project step ───────────────────────────────────────────────────

  const createProject = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('name', name);
      if (description) fd.append('description', description);
      fd.append('coordinate_system', coordSys);
      const proj = await projectsApi.create(fd);
      setProjectId(proj.id);
      setStep(1);
    } catch {
      setError('Failed to create project');
    } finally {
      setSubmitting(false);
    }
  };

  // ── Upload images ─────────────────────────────────────────────────────────

  const uploadFiles = async (files: FileList) => {
    if (!projectId || files.length === 0) return;
    setUploadState(s => ({ ...s, uploading: true, error: null }));
    try {
      const result = await projectsApi.uploadImages(projectId, files);
      setUploadState({ count: result.total_images, uploading: false, summary: result.exif_summary, error: null });
      applyExifRtk(result.exif_summary);
    } catch {
      setUploadState(s => ({ ...s, uploading: false, error: 'Upload failed' }));
    }
  };

  const onDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    if (e.dataTransfer.files.length > 0) await uploadFiles(e.dataTransfer.files);
  }, [projectId]);

  // ── Save RTK config ───────────────────────────────────────────────────────

  const saveRtkConfig = async () => {
    if (!projectId) return;
    try {
      await projectsApi.updateRtkConfig(projectId, {
        rtk_accuracy_h: rtkAccH ? parseFloat(rtkAccH) : undefined,
        rtk_accuracy_v: rtkAccV ? parseFloat(rtkAccV) : undefined,
        rtk_mode: rtkMode,
      });
    } catch { /* non-fatal */ }
  };

  // ── Start processing ──────────────────────────────────────────────────────

  const startProcessing = async () => {
    if (!projectId) return;
    setSubmitting(true);
    setError(null);
    try {
      // Save GCPs
      if (gcps.length > 0) await projectsApi.saveGCPs(projectId, gcps);
      // Save RTK config
      await saveRtkConfig();
      // Build custom options JSON
      const customOptionsJson = Object.keys(customOverrides).length > 0
        ? JSON.stringify(customOverrides)
        : undefined;
      // Launch job
      await jobsApi.start(projectId, preset, customOptionsJson);
      navigate(`/projects/${projectId}`);
    } catch (e: any) {
      setError(e?.response?.data?.detail || 'Failed to start processing');
      setSubmitting(false);
    }
  };

  const canAdvance = [
    name.trim().length > 0,
    uploadState.count > 0,
    true,   // RTK is always optional
    true,   // Preset always has a value
    true,   // GCPs are optional
  ];

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="page-content" style={{ maxWidth: 860, margin: '0 auto' }}>
      <div className="page-header">
        <div className="page-header-left">
          <div className="flex items-center gap-3">
            <button className="btn btn-ghost btn-sm" onClick={() => navigate('/')}>← Back</button>
            <h1>New Project</h1>
          </div>
          <p className="text-secondary text-sm">Set up your photogrammetry project and processing pipeline</p>
        </div>
      </div>

      {/* Step nav */}
      <div className="flex gap-2 mb-6">
        {STEPS.map((s, i) => {
          const isDone = i < step;
          const isActive = i === step;
          const canGo = i < step || (i === step + 1 && canAdvance[step]);
          return (
            <button
              key={s.id}
              type="button"
              className="btn"
              style={{
                flex: 1, flexDirection: 'column', gap: 4, padding: '10px 8px', fontSize: 11,
                background: isActive ? 'var(--accent-subtle)' : isDone ? 'rgba(34,197,94,0.08)' : 'var(--bg-elevated)',
                border: `1px solid ${isActive ? 'var(--accent)' : isDone ? 'rgba(34,197,94,0.3)' : 'var(--border)'}`,
                color: isActive ? 'var(--accent)' : isDone ? 'var(--success)' : 'var(--text-muted)',
                cursor: canGo ? 'pointer' : 'not-allowed',
                opacity: canGo || isActive ? 1 : 0.5,
              }}
              onClick={() => { if (canGo) setStep(i); }}
            >
              <span style={{ fontSize: 18 }}>{isDone ? '✓' : s.icon}</span>
              <span>{s.label}</span>
            </button>
          );
        })}
      </div>

      {error && (
        <div className="card mb-4" style={{ borderColor: 'var(--error)', background: 'rgba(239,68,68,0.07)', padding: '12px 16px' }}>
          <span className="text-error">{error}</span>
        </div>
      )}

      {/* ── Step 0: Details ──────────────────────────────────────────────────── */}
      {step === 0 && (
        <div className="card animate-fade">
          <h2 className="mb-4">Project Details</h2>
          <div className="form-group">
            <label>Project Name *</label>
            <input className="input" value={name} onChange={e => setName(e.target.value)}
              placeholder="e.g. Site A — June Survey" />
          </div>
          <div className="form-group">
            <label>Description</label>
            <textarea className="textarea" rows={3} value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Optional notes about the project area, flight parameters, etc." />
          </div>
          <div className="form-group">
            <label>Coordinate System</label>
            <select className="select" value={coordSys} onChange={e => setCoordSys(e.target.value)}>
              <option value="EPSG:4326">WGS84 (EPSG:4326) — Lat/Lon</option>
              <option value="EPSG:32654">WGS84 UTM Zone 54N (EPSG:32654)</option>
              <option value="EPSG:32610">WGS84 UTM Zone 10N (EPSG:32610)</option>
              <option value="EPSG:27700">British National Grid (EPSG:27700)</option>
              <option value="EPSG:3857">Web Mercator (EPSG:3857)</option>
            </select>
          </div>
          <div className="flex justify-end mt-4">
            <button className="btn btn-primary btn-lg" disabled={!name.trim() || submitting} onClick={createProject}>
              {submitting ? 'Creating…' : 'Create Project →'}
            </button>
          </div>
        </div>
      )}

      {/* ── Step 1: Images ───────────────────────────────────────────────────── */}
      {step === 1 && (
        <div className="card animate-fade">
          <h2 className="mb-4">Upload Images</h2>
          <div
            className={`dropzone ${dragActive ? 'drag-active' : ''}`}
            onClick={() => !uploadState.uploading && fileInputRef.current?.click()}
            onDragOver={e => { e.preventDefault(); setDragActive(true); }}
            onDragLeave={() => setDragActive(false)}
            onDrop={onDrop}
          >
            <div className="dropzone-icon">{uploadState.uploading ? '⟳' : '📷'}</div>
            {uploadState.uploading ? (
              <h3>Uploading images…</h3>
            ) : uploadState.count > 0 ? (
              <>
                <h3 style={{ color: 'var(--success)' }}>✓ {uploadState.count} images uploaded</h3>
                <p>Click or drag to add more images</p>
              </>
            ) : (
              <>
                <h3>Drop your images here</h3>
                <p>JPG, PNG, TIFF — any number of images</p>
              </>
            )}
            <input ref={fileInputRef} type="file" multiple accept="image/*,.tif,.tiff"
              onChange={e => e.target.files && uploadFiles(e.target.files)} style={{ display: 'none' }} />
          </div>

          {uploadState.error && <p className="text-error mt-2">{uploadState.error}</p>}

          {/* EXIF summary */}
          {uploadState.summary && (
            <div className="card mt-4" style={{ background: 'var(--bg-secondary)', padding: 16 }}>
              <h4 className="mb-3">EXIF Summary</h4>
              <div className="grid-4 gap-2">
                <div className="stat-tile" style={{ padding: '12px 14px' }}>
                  <div className="stat-tile-label">Total Images</div>
                  <div className="stat-tile-value" style={{ fontSize: 20 }}>{uploadState.summary.total_images.toLocaleString()}</div>
                </div>
                <div className="stat-tile" style={{ padding: '12px 14px' }}>
                  <div className="stat-tile-label">GPS Coverage</div>
                  <div className="stat-tile-value" style={{ fontSize: 20, color: uploadState.summary.has_gps_pct > 90 ? 'var(--success)' : 'var(--warning)' }}>
                    {uploadState.summary.has_gps_pct}%
                  </div>
                </div>
                <div className="stat-tile" style={{ padding: '12px 14px' }}>
                  <div className="stat-tile-label">RTK Fix</div>
                  <div className="stat-tile-value" style={{ fontSize: 20, color: (uploadState.summary.rtk_fix_pct || 0) > 80 ? 'var(--accent)' : 'var(--text-secondary)' }}>
                    {uploadState.summary.rtk_fix_pct}%
                  </div>
                </div>
                <div className="stat-tile" style={{ padding: '12px 14px' }}>
                  <div className="stat-tile-label">Camera</div>
                  <div style={{ fontSize: 13, fontWeight: 600, marginTop: 4 }} className="truncate">
                    {uploadState.summary.camera_makes.join(', ') || '—'}
                  </div>
                </div>
              </div>

              {/* RTK quality breakdown */}
              {uploadState.summary.qualities && Object.keys(uploadState.summary.qualities).length > 0 && (
                <div className="flex gap-2 mt-3 flex-wrap">
                  {Object.entries(uploadState.summary.qualities).map(([q, n]) => (
                    <span key={q} style={{
                      fontSize: 11, padding: '3px 10px', borderRadius: 99, fontWeight: 600,
                      background: q === 'RTK Fix' ? 'rgba(0,212,170,0.15)' : q === 'RTK Float' ? 'rgba(59,130,246,0.15)' : 'rgba(100,116,139,0.15)',
                      color: q === 'RTK Fix' ? 'var(--accent)' : q === 'RTK Float' ? 'var(--info)' : 'var(--text-muted)',
                    }}>
                      {q}: {n}
                    </span>
                  ))}
                </div>
              )}

              {uploadState.summary.avg_acc_h && (
                <div className="text-xs text-accent mt-2">
                  📍 Estimated from EXIF: H ±{(uploadState.summary.avg_acc_h * 100).toFixed(1)} cm,
                  V ±{((uploadState.summary.avg_acc_v ?? uploadState.summary.avg_acc_h * 1.5) * 100).toFixed(1)} cm
                </div>
              )}
            </div>
          )}

          <div className="flex justify-between mt-6">
            <button className="btn btn-ghost" onClick={() => setStep(0)}>← Back</button>
            <button className="btn btn-primary" disabled={uploadState.count === 0} onClick={() => setStep(2)}>
              Continue →
            </button>
          </div>
        </div>
      )}

      {/* ── Step 2: RTK ──────────────────────────────────────────────────────── */}
      {step === 2 && (
        <div className="card animate-fade">
          <h2 className="mb-2">GPS & RTK Configuration</h2>
          <p className="text-sm mb-4">
            Tell OpenDroneMap how accurate your drone's GPS is. This directly affects
            how the reconstruction is anchored in real-world coordinates.
          </p>

          <RtkConfigPanel
            mode={rtkMode} accH={rtkAccH} accV={rtkAccV}
            onMode={setRtkMode} onAccH={setRtkAccH} onAccV={setRtkAccV}
          />

          <div className="card mt-4" style={{ background: 'var(--bg-secondary)', padding: 14 }}>
            <div className="text-xs text-muted">
              <strong style={{ color: 'var(--text-secondary)' }}>What happens with this data?</strong><br />
              These values are passed to ODM as <code>--gps-accuracy</code> and
              <code>--gps-accuracy-vert</code>. When GCPs are also present, ODM uses both
              to weight its bundle adjustment.
            </div>
          </div>

          <div className="flex justify-between mt-6">
            <button className="btn btn-ghost" onClick={() => setStep(1)}>← Back</button>
            <button className="btn btn-primary" onClick={() => setStep(3)}>Continue →</button>
          </div>
        </div>
      )}

      {/* ── Step 3: Preset ───────────────────────────────────────────────────── */}
      {step === 3 && (
        <div className="card animate-fade">
          <h2 className="mb-4">Processing Preset</h2>
          <PresetPicker value={preset} onChange={v => { setPreset(v); setCustomOverrides({}); }} />

          <AdvancedOptions
            overrides={customOverrides}
            onChange={setCustomOverrides}
            basePreset={preset}
          />

          {Object.keys(customOverrides).length > 0 && (
            <div className="mt-3" style={{
              background: 'rgba(0,212,170,0.07)', borderRadius: 8, padding: '10px 14px',
              border: '1px solid rgba(0,212,170,0.2)', fontSize: 12,
            }}>
              <div className="text-accent font-bold mb-1">Active Overrides</div>
              <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: 'var(--text-secondary)' }}>
                {JSON.stringify(customOverrides, null, 2)}
              </div>
            </div>
          )}

          <div className="flex justify-between mt-6">
            <button className="btn btn-ghost" onClick={() => setStep(2)}>← Back</button>
            <button className="btn btn-primary" onClick={() => setStep(4)}>Continue →</button>
          </div>
        </div>
      )}

      {/* ── Step 4: GCPs ─────────────────────────────────────────────────────── */}
      {step === 4 && (
        <div className="card animate-fade">
          <h2 className="mb-2">Ground Control Points</h2>
          <p className="text-sm mb-4">
            GCPs are optional but significantly improve absolute accuracy. Each GCP needs
            surveyed coordinates (X/Y/Z) and at least one image observation.
          </p>
          <GCPEditor gcps={gcps} onChange={setGcps} />

          <div className="flex justify-between mt-6">
            <button className="btn btn-ghost" onClick={() => setStep(3)}>← Back</button>
            <button
              className="btn btn-primary btn-lg"
              disabled={submitting}
              onClick={startProcessing}
            >
              {submitting ? '🚀 Starting…' : '🚀 Start Processing'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function PresetPicker({ value, onChange }: { value: ProcessingPreset; onChange: (v: ProcessingPreset) => void }) {
  return (
    <div className="preset-cards">
      {PRESETS.map(p => (
        <div
          key={p.id}
          className={`preset-card ${value === p.id ? 'selected' : ''}`}
          onClick={() => onChange(p.id)}
        >
          <div className="preset-card-icon">{p.icon}</div>
          <h3>{p.name}</h3>
          <p>{p.desc}</p>
          <div className="text-xs text-accent mt-2">{p.time}</div>
        </div>
      ))}
    </div>
  );
}
