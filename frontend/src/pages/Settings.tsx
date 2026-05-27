import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { systemApi, api } from '../api';
import { useSettings } from '../hooks/useSettings';
import { useToast } from '../hooks/useToast';

type ConnState = 'idle' | 'testing' | 'ok' | 'error';

export default function Settings() {
  const { settings, update, save, reset, dirty } = useSettings();
  const { toast } = useToast();
  const [connState, setConnState] = useState<ConnState>('idle');
  const [connMsg,   setConnMsg]   = useState('');

  const { data: potree } = useQuery({
    queryKey: ['potree-status'],
    queryFn:  systemApi.potreeStatus,
    retry: false,
  });

  const handleSave = () => {
    save();
    // Update the axios base URL immediately
    api.defaults.baseURL = settings.apiUrl;
    toast.success('Settings saved', 'Configuration persisted to disk');
  };

  const testConnection = async () => {
    setConnState('testing');
    setConnMsg('');
    try {
      const r = await fetch(`${settings.apiUrl}/system/stats`);
      if (r.ok) {
        setConnState('ok');
        setConnMsg('Backend reachable ✓');
        toast.success('Backend connected', settings.apiUrl);
      } else {
        setConnState('error');
        setConnMsg(`HTTP ${r.status}`);
      }
    } catch (e: any) {
      setConnState('error');
      setConnMsg(e?.message ?? 'Connection refused');
    }
  };

  const connColor = { idle: 'var(--text-muted)', testing: 'var(--warning)', ok: 'var(--success)', error: 'var(--error)' }[connState];

  return (
    <div className="page-content" style={{ maxWidth: 740 }}>
      <div className="page-header">
        <div className="page-header-left">
          <h1>Settings</h1>
          <p className="text-secondary text-sm">Configure your local processing environment</p>
        </div>
        <div className="flex gap-2">
          <button className="btn btn-ghost btn-sm" onClick={reset}>Reset defaults</button>
          <button
            className="btn btn-primary"
            onClick={handleSave}
            disabled={!dirty}
            style={{ minWidth: 120 }}
          >
            {dirty ? 'Save Changes' : '✓ Saved'}
          </button>
        </div>
      </div>

      {/* ── Backend Connection ──────────────────────────────────────── */}
      <div className="card mb-4">
        <h2 className="mb-4">Backend Connection</h2>
        <div className="form-group">
          <label>API Server URL</label>
          <div className="flex gap-2">
            <input
              className="input font-mono"
              value={settings.apiUrl}
              onChange={e => update('apiUrl', e.target.value)}
              placeholder="http://localhost:8000"
            />
            <button
              className="btn btn-secondary"
              style={{ flexShrink: 0 }}
              disabled={connState === 'testing'}
              onClick={testConnection}
            >
              {connState === 'testing' ? '⟳ Testing…' : '⚡ Test'}
            </button>
          </div>
          {connMsg && (
            <div className="text-xs mt-1" style={{ color: connColor }}>{connMsg}</div>
          )}
          <div className="text-xs text-muted mt-1">
            Start with: <code>python start_backend.py</code> or <code>docker compose up -d</code>
          </div>
        </div>
        <div className="form-group">
          <label>NodeODM URL</label>
          <input
            className="input font-mono"
            value={settings.nodeoUrl}
            onChange={e => update('nodeoUrl', e.target.value)}
          />
          <div className="text-xs text-muted mt-1">Processing engine container (port 3000)</div>
        </div>
        <div className="form-group">
          <label>WebSocket URL</label>
          <input
            className="input font-mono"
            value={settings.wsUrl}
            onChange={e => update('wsUrl', e.target.value)}
          />
          <div className="text-xs text-muted mt-1">Live job progress stream (ws:// equivalent of API URL)</div>
        </div>
      </div>

      {/* ── Processing Defaults ─────────────────────────────────────── */}
      <div className="card mb-4">
        <h2 className="mb-4">Processing Defaults</h2>
        <div className="form-group">
          <label>Default Processing Preset</label>
          <select
            className="select"
            value={settings.defaultPreset}
            onChange={e => update('defaultPreset', e.target.value as typeof settings.defaultPreset)}
          >
            <option value="fast_preview">⚡ Fast Preview — quick check, lower quality</option>
            <option value="survey_grade">🎯 Survey Grade — balanced accuracy/speed</option>
            <option value="high_fidelity">💎 High Fidelity — maximum quality, slow</option>
          </select>
        </div>

        <div className="input-row">
          <div className="form-group">
            <label>Split Size (images per tile)</label>
            <input
              className="input font-mono" type="number" min={50} max={1000}
              value={settings.splitSize}
              onChange={e => update('splitSize', Number(e.target.value))}
            />
            <div className="text-xs text-muted mt-1">Lower = less RAM. Recommended: 150–300.</div>
          </div>
          <div className="form-group">
            <label>Split Overlap (meters)</label>
            <input
              className="input font-mono" type="number" min={10} max={200}
              value={settings.splitOverlap}
              onChange={e => update('splitOverlap', Number(e.target.value))}
            />
            <div className="text-xs text-muted mt-1">Overlap prevents seams between submodels.</div>
          </div>
        </div>

        <div className="flex items-center gap-3 mt-2">
          <input
            type="checkbox" id="auto-start"
            checked={settings.autoStartJobs}
            onChange={e => update('autoStartJobs', e.target.checked)}
          />
          <label htmlFor="auto-start" style={{ marginBottom: 0, cursor: 'pointer' }}>
            Auto-start processing after image upload
          </label>
        </div>

        <div className="card mt-3" style={{ background: 'var(--accent-subtle)', border: '1px solid var(--border-accent)', padding: 14 }}>
          <div className="text-sm text-accent font-bold mb-1">RTX 4070 Recommended</div>
          <div className="text-xs text-secondary">
            Split: 200 · Overlap: 50m · Survey Grade<br />
            Expected RAM peak: ~24–40 GB · VRAM: ~8–10 GB
          </div>
        </div>
      </div>

      {/* ── Notifications ───────────────────────────────────────────── */}
      <div className="card mb-4">
        <h2 className="mb-4">Notifications</h2>
        <div className="flex items-center gap-3">
          <input
            type="checkbox" id="notif-toggle"
            checked={settings.notifications}
            onChange={e => update('notifications', e.target.checked)}
          />
          <div>
            <label htmlFor="notif-toggle" style={{ marginBottom: 0, cursor: 'pointer' }}>
              Desktop notifications when jobs complete
            </label>
            <div className="text-xs text-muted mt-1">
              Uses Tauri native notifications in the desktop app, or browser notifications on the web.
            </div>
          </div>
        </div>
      </div>

      {/* ── PotreeConverter ─────────────────────────────────────────── */}
      <div className="card mb-4">
        <div className="flex items-center justify-between mb-4">
          <h2>PotreeConverter</h2>
          <span style={{
            padding: '4px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600,
            background: potree?.available ? 'rgba(0,212,170,0.12)' : 'rgba(239,68,68,0.12)',
            color: potree?.available ? 'var(--success)' : potree === undefined ? 'var(--text-muted)' : 'var(--error)',
            border: `1px solid ${potree?.available ? 'rgba(0,212,170,0.3)' : 'rgba(239,68,68,0.3)'}`,
          }}>
            {potree === undefined ? 'Checking…' : potree.available ? '✓ Installed' : '✕ Not Found'}
          </span>
        </div>
        <p className="text-sm mb-3">
          Indexes LAZ point clouds into Potree EPT format for interactive streaming at any scale.
        </p>
        {potree?.available && potree.path && (
          <div className="form-group">
            <label>Binary Path</label>
            <input className="input font-mono" value={potree.path} readOnly style={{ opacity: 0.7 }} />
          </div>
        )}
        {potree !== undefined && !potree.available && (
          <div className="card" style={{ background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.2)', padding: 14 }}>
            <div className="text-sm font-bold mb-1" style={{ color: 'var(--error)' }}>Not detected</div>
            <div className="text-xs text-secondary">
              Linux/WSL2: <code style={{ color: 'var(--accent)' }}>apt install potreeconverter</code><br />
              Or download from <code style={{ color: 'var(--accent)' }}>github.com/potree/PotreeConverter</code>
              and set <code style={{ color: 'var(--accent)' }}>POTREECONVERTER_PATH</code> in <code>.env</code>
            </div>
          </div>
        )}
      </div>

      {/* ── Docker Stack ────────────────────────────────────────────── */}
      <div className="card mb-6">
        <h2 className="mb-4">Docker Stack</h2>
        <p className="text-sm mb-3">Manage the processing engine containers.</p>
        <div className="flex-col gap-2">
          {[
            { label: 'Start all services',  cmd: 'docker compose up -d',     color: 'var(--success)' },
            { label: 'Stop all services',   cmd: 'docker compose down',       color: 'var(--warning)' },
            { label: 'View logs',           cmd: 'docker compose logs -f',    color: 'var(--info)' },
            { label: 'Enable GPU (NVIDIA)', cmd: 'Uncomment deploy section in docker-compose.yml', color: 'var(--accent)' },
          ].map(item => (
            <div key={item.label} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              background: 'var(--bg-secondary)', padding: '10px 14px',
              borderRadius: 'var(--radius-md)', border: '1px solid var(--border)',
            }}>
              <span className="text-sm text-muted">{item.label}</span>
              <code className="text-xs font-mono" style={{ color: item.color }}>{item.cmd}</code>
            </div>
          ))}
        </div>
      </div>

      <div className="flex justify-end gap-3">
        <button className="btn btn-ghost" onClick={reset}>Reset to defaults</button>
        <button className="btn btn-primary btn-lg" onClick={handleSave} disabled={!dirty}>
          {dirty ? 'Save Changes' : '✓ All Saved'}
        </button>
      </div>
    </div>
  );
}
