/**
 * BatchImport — drag a root folder containing sub-folders of images.
 * Each sub-folder becomes one project. Shows preview, lets user
 * configure shared settings, then creates all projects and queues jobs.
 *
 * Route: /batch-import
 */

import { useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { projectsApi, jobsApi, type ProcessingPreset } from '../api';

// ─── Types ────────────────────────────────────────────────────────────────────

interface FolderEntry {
  name: string;
  files: File[];
  imageCount: number;
  selected: boolean;
  status: 'pending' | 'uploading' | 'queued' | 'error';
  error?: string;
  projectId?: string;
}

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.tif', '.tiff']);

function isImage(file: File): boolean {
  const ext = '.' + file.name.split('.').pop()?.toLowerCase();
  return IMAGE_EXTS.has(ext);
}

// ─── Progress bar ─────────────────────────────────────────────────────────────

function MiniProgress({ pct, color }: { pct: number; color: string }) {
  return (
    <div className="progress-bar" style={{ height: 4, marginTop: 4 }}>
      <div className="progress-bar-fill" style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function BatchImport() {
  const navigate  = useNavigate();
  const inputRef  = useRef<HTMLInputElement>(null);

  const [folders, setFolders]   = useState<FolderEntry[]>([]);
  const [dragOver, setDragOver] = useState(false);

  // Shared settings
  const [coordSys,  setCoordSys]  = useState('EPSG:4326');
  const [preset,    setPreset]    = useState<ProcessingPreset>('survey_grade');
  const [startJobs, setStartJobs] = useState(true);

  // Submission state
  const [running,   setRunning]   = useState(false);
  const [done,      setDone]      = useState(false);
  const [progress,  setProgress]  = useState(0); // 0-100 overall

  // ── Parse dropped/selected files into folder groups ──────────────────────
  const parseFiles = (files: FileList | File[]) => {
    const arr = Array.from(files);
    const byFolder: Map<string, File[]> = new Map();

    for (const file of arr) {
      // webkitRelativePath: "FolderName/sub/image.jpg"
      const rel = (file as any).webkitRelativePath as string || file.name;
      const parts = rel.split('/');
      const folder = parts.length > 1 ? parts[0] : '(root)';
      if (!byFolder.has(folder)) byFolder.set(folder, []);
      if (isImage(file)) byFolder.get(folder)!.push(file);
    }

    const entries: FolderEntry[] = Array.from(byFolder.entries())
      .filter(([, files]) => files.length > 0)
      .map(([name, files]) => ({
        name, files, imageCount: files.length,
        selected: true, status: 'pending',
      }));

    setFolders(entries);
    setDone(false);
    setProgress(0);
  };

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) parseFiles(e.target.files);
  };

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length > 0) parseFiles(e.dataTransfer.files);
  }, []);

  const toggleFolder = (i: number) => {
    setFolders(prev => prev.map((f, idx) => idx === i ? { ...f, selected: !f.selected } : f));
  };

  const setFolderStatus = (i: number, status: FolderEntry['status'], extra?: Partial<FolderEntry>) => {
    setFolders(prev => prev.map((f, idx) => idx === i ? { ...f, status, ...extra } : f));
  };

  // ── Run batch import ──────────────────────────────────────────────────────
  const runImport = async () => {
    const selected = folders.filter(f => f.selected);
    if (selected.length === 0) return;
    setRunning(true);
    setDone(false);

    let completed = 0;

    for (let i = 0; i < folders.length; i++) {
      const f = folders[i];
      if (!f.selected) continue;

      setFolderStatus(i, 'uploading');

      try {
        // 1. Create project
        const fd = new FormData();
        fd.append('name', f.name);
        fd.append('coordinate_system', coordSys);
        const proj = await projectsApi.create(fd);

        setFolderStatus(i, 'uploading', { projectId: proj.id });

        // 2. Upload images (build a FileList-like object)
        const dt = new DataTransfer();
        f.files.forEach(file => dt.items.add(file));
        await projectsApi.uploadImages(proj.id, dt.files);

        // 3. Optionally start job
        if (startJobs) {
          await jobsApi.start(proj.id, preset);
        }

        setFolderStatus(i, 'queued', { projectId: proj.id });
      } catch (err: any) {
        setFolderStatus(i, 'error', { error: err?.message ?? 'Unknown error' });
      }

      completed++;
      setProgress(Math.round((completed / selected.length) * 100));
    }

    setRunning(false);
    setDone(true);
  };

  const selectedCount = folders.filter(f => f.selected).length;
  const totalImages   = folders.filter(f => f.selected).reduce((a, f) => a + f.imageCount, 0);

  return (
    <div className="page-content" style={{ maxWidth: 860, margin: '0 auto' }}>
      <div className="page-header">
        <div className="page-header-left">
          <div className="flex items-center gap-3">
            <button className="btn btn-ghost btn-sm" onClick={() => navigate('/')}>← Back</button>
            <h1>📦 Batch Import</h1>
          </div>
          <p className="text-secondary text-sm">
            Import multiple project folders at once. Each sub-folder becomes a separate project.
          </p>
        </div>
      </div>

      {/* Drop zone */}
      {folders.length === 0 && (
        <div
          className={`dropzone ${dragOver ? 'drag-active' : ''}`}
          style={{ minHeight: 280 }}
          onDragOver={e => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          onClick={() => inputRef.current?.click()}
        >
          <div className="dropzone-icon">📂</div>
          <h3>Drop your image folder here</h3>
          <p>Each sub-folder will become a separate project</p>
          <p className="text-xs text-muted mt-2">
            Structure: <code>RootFolder / SiteName / *.jpg</code>
          </p>
          <input
            ref={inputRef}
            type="file"
            // @ts-ignore - non-standard but widely supported
            webkitdirectory=""
            multiple
            onChange={onInputChange}
            style={{ display: 'none' }}
          />
        </div>
      )}

      {/* Folder list */}
      {folders.length > 0 && (
        <>
          <div className="card mb-4">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3>{folders.length} folder{folders.length !== 1 ? 's' : ''} detected</h3>
                <div className="text-xs text-muted mt-1">
                  {selectedCount} selected · {totalImages.toLocaleString()} images
                </div>
              </div>
              <div className="flex gap-2">
                <button className="btn btn-ghost btn-sm" onClick={() => {
                  setFolders(prev => prev.map(f => ({ ...f, selected: true })));
                }}>Select All</button>
                <button className="btn btn-ghost btn-sm" onClick={() => {
                  setFolders(prev => prev.map(f => ({ ...f, selected: false })));
                }}>Deselect All</button>
                <button className="btn btn-secondary btn-sm" onClick={() => {
                  setFolders([]); setDone(false); setProgress(0);
                }}>✕ Clear</button>
              </div>
            </div>

            {/* Folder rows */}
            <div className="flex-col gap-2">
              {folders.map((f, i) => {
                const statusColor = {
                  pending:   'var(--text-muted)',
                  uploading: 'var(--accent)',
                  queued:    'var(--success)',
                  error:     'var(--error)',
                }[f.status];
                const statusIcon = {
                  pending:   '⏳',
                  uploading: '⟳',
                  queued:    '✅',
                  error:     '✕',
                }[f.status];

                return (
                  <div
                    key={f.name}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 12,
                      padding: '10px 14px', borderRadius: 'var(--radius-md)',
                      background: f.selected ? 'var(--bg-elevated)' : 'var(--bg-secondary)',
                      border: `1px solid ${f.selected ? 'var(--border-accent)' : 'var(--border)'}`,
                      opacity: running && !f.selected ? 0.4 : 1,
                    }}
                  >
                    <input
                      type="checkbox" checked={f.selected} disabled={running}
                      onChange={() => toggleFolder(i)}
                      style={{ cursor: 'pointer', accentColor: 'var(--accent)' }}
                    />
                    <span style={{ fontSize: 18 }}>📁</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 13 }} className="truncate">{f.name}</div>
                      <div className="text-xs text-muted">{f.imageCount.toLocaleString()} images</div>
                      {f.status === 'uploading' && <MiniProgress pct={50} color="var(--accent)" />}
                      {f.error && <div className="text-xs text-error mt-1">{f.error}</div>}
                    </div>
                    <div className="flex items-center gap-2">
                      {f.projectId && f.status === 'queued' && (
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => navigate(`/projects/${f.projectId}`)}
                          style={{ fontSize: 11 }}
                        >
                          View →
                        </button>
                      )}
                      <span style={{ fontSize: 14, color: statusColor }}>{statusIcon}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Shared settings */}
          {!done && (
            <div className="card mb-4">
              <h3 className="mb-4">Shared Settings</h3>
              <div className="input-row">
                <div className="form-group">
                  <label>Coordinate System</label>
                  <select className="select" value={coordSys} onChange={e => setCoordSys(e.target.value)}>
                    <option value="EPSG:4326">WGS84 (EPSG:4326)</option>
                    <option value="EPSG:32654">WGS84 UTM Zone 54N</option>
                    <option value="EPSG:32610">WGS84 UTM Zone 10N</option>
                    <option value="EPSG:27700">British National Grid</option>
                    <option value="EPSG:3857">Web Mercator</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>Processing Preset</label>
                  <select className="select" value={preset} onChange={e => setPreset(e.target.value as ProcessingPreset)}>
                    <option value="fast_preview">⚡ Fast Preview</option>
                    <option value="survey_grade">🎯 Survey Grade</option>
                    <option value="high_fidelity">💎 High Fidelity</option>
                  </select>
                </div>
              </div>
              <div className="flex items-center gap-3 mt-2">
                <input
                  type="checkbox" id="start-jobs" checked={startJobs}
                  onChange={e => setStartJobs(e.target.checked)}
                  style={{ accentColor: 'var(--accent)', cursor: 'pointer' }}
                />
                <label htmlFor="start-jobs" style={{ fontSize: 13, cursor: 'pointer' }}>
                  Automatically start processing after upload
                </label>
              </div>
            </div>
          )}

          {/* Overall progress */}
          {running && (
            <div className="card mb-4" style={{ borderColor: 'rgba(0,212,170,0.3)' }}>
              <div className="flex items-center justify-between mb-2">
                <span style={{ fontWeight: 600, color: 'var(--accent)' }}>Importing…</span>
                <span className="text-xs text-muted">{progress}%</span>
              </div>
              <MiniProgress pct={progress} color="var(--accent)" />
            </div>
          )}

          {/* Done state */}
          {done && (
            <div className="card mb-4" style={{ borderColor: 'rgba(34,197,94,0.3)', background: 'rgba(34,197,94,0.05)' }}>
              <div className="flex items-center gap-3 mb-3">
                <span style={{ fontSize: 24 }}>✅</span>
                <div>
                  <div style={{ fontWeight: 700, color: 'var(--success)' }}>Import Complete</div>
                  <div className="text-xs text-muted">
                    {folders.filter(f => f.status === 'queued').length} projects created
                    {startJobs ? ' and queued for processing' : ''}
                  </div>
                </div>
              </div>
              <div className="flex gap-2">
                <button className="btn btn-primary" onClick={() => navigate('/')}>
                  View Dashboard
                </button>
                {startJobs && (
                  <button className="btn btn-secondary" onClick={() => navigate('/queue')}>
                    📋 View Queue
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Action buttons */}
          {!done && (
            <div className="flex justify-end gap-3">
              <button className="btn btn-ghost" onClick={() => navigate('/')}>Cancel</button>
              <button
                className="btn btn-primary btn-lg"
                disabled={running || selectedCount === 0}
                onClick={runImport}
              >
                {running
                  ? `⟳ Importing ${progress}%…`
                  : `🚀 Import ${selectedCount} Project${selectedCount !== 1 ? 's' : ''}`}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
