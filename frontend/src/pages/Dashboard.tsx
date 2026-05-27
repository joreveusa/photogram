import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { projectsApi, systemApi, jobsApi, type Project, type SystemStats, type Job } from '../api';
import MiniMap from '../components/MiniMap';

// ─── Status Badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`badge badge-${status}`}>
      <span className="badge-dot" />
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

// ─── Hardware Monitor ─────────────────────────────────────────────────────────

function HardwareMonitor() {
  const { data: stats } = useQuery<SystemStats>({
    queryKey: ['system-stats'],
    queryFn: systemApi.stats,
    refetchInterval: 5000,
  });

  const rows = stats ? [
    { label: 'CPU',  value: `${stats.cpu.percent.toFixed(0)}%`,                  pct: stats.cpu.percent },
    { label: 'RAM',  value: `${stats.memory.used_gb} / ${stats.memory.total_gb} GB`, pct: stats.memory.percent },
    { label: 'Disk', value: `${stats.disk.free_gb} GB free`,                     pct: stats.disk.percent },
    ...(stats.gpu.name ? [{ label: 'GPU', value: `${stats.gpu.utilization_percent.toFixed(0)}%`, pct: stats.gpu.utilization_percent }] : []),
  ] : [];

  return (
    <div className="card" style={{ height: '100%' }}>
      <h4 className="mb-4">Hardware Monitor</h4>
      {!stats ? (
        <p className="text-sm text-muted">Connecting to backend…</p>
      ) : (
        <div className="hw-monitor">
          {rows.map(r => (
            <div key={r.label} className="hw-row">
              <div className="hw-row-header">
                <span className="hw-row-label">{r.label}</span>
                <span className="hw-row-value">{r.value}</span>
              </div>
              <div className="progress-bar">
                <div
                  className={`progress-bar-fill ${r.label !== 'Disk' ? 'pulsing' : ''}`}
                  style={{
                    width: `${r.pct}%`,
                    background: r.pct > 85
                      ? 'linear-gradient(90deg, var(--warning), #f97316)'
                      : undefined,
                  }}
                />
              </div>
            </div>
          ))}
          {stats.gpu.name && (
            <div className="text-xs text-muted">{stats.gpu.name} — {stats.gpu.memory_used_mb.toFixed(0)} / {stats.gpu.memory_total_mb.toFixed(0)} MB VRAM</div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Active Job Ticker ────────────────────────────────────────────────────────

function ActiveJobTicker({ jobs, projects }: { jobs: Job[]; projects: Project[] }) {
  const navigate = useNavigate();
  const projectMap = Object.fromEntries(projects.map(p => [p.id, p]));

  if (jobs.length === 0) return null;

  return (
    <div className="card mb-4" style={{
      borderColor: 'rgba(0,212,170,0.25)',
      background: 'rgba(0,212,170,0.04)',
    }}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div style={{
            width: 8, height: 8, borderRadius: '50%',
            background: 'var(--accent)',
            boxShadow: '0 0 10px var(--accent)',
            animation: 'pulse 2s infinite',
          }} />
          <h4 style={{ color: 'var(--accent)' }}>
            {jobs.length} job{jobs.length !== 1 ? 's' : ''} processing
          </h4>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={() => navigate('/queue')}>
          View Queue →
        </button>
      </div>
      <div className="flex-col gap-2">
        {jobs.slice(0, 3).map(j => {
          const proj = projectMap[j.project_id];
          return (
            <div key={j.id} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="text-sm truncate" style={{ color: 'var(--text-primary)' }}>
                  {proj?.name ?? j.project_id.slice(0, 8)}
                </div>
                <div className="text-xs text-muted truncate">{j.current_step ?? j.status}</div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                <div className="progress-bar" style={{ width: 100, height: 4 }}>
                  <div
                    className="progress-bar-fill pulsing"
                    style={{ width: `${j.progress}%` }}
                  />
                </div>
                <span className="text-xs" style={{ color: 'var(--accent)', minWidth: 32 }}>
                  {j.progress.toFixed(0)}%
                </span>
              </div>
            </div>
          );
        })}
        {jobs.length > 3 && (
          <div className="text-xs text-muted text-center">
            +{jobs.length - 3} more in queue
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Rename Modal ─────────────────────────────────────────────────────────────

function RenameModal({ project, onClose }: { project: Project; onClose: () => void }) {
  const [name, setName] = React.useState(project.name);
  const [desc, setDesc] = React.useState(project.description ?? '');
  const qc = useQueryClient();

  const save = async () => {
    if (!name.trim()) return;
    await projectsApi.update(project.id, { name: name.trim(), description: desc });
    qc.invalidateQueries({ queryKey: ['projects'] });
    onClose();
  };

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div className="card" style={{ width: 420, padding: 28 }}>
        <h3 style={{ marginBottom: 20 }}>Rename Project</h3>
        <div style={{ marginBottom: 14 }}>
          <label className="text-xs text-muted" style={{ display: 'block', marginBottom: 6 }}>Project Name</label>
          <input
            className="input"
            style={{ width: '100%' }}
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && save()}
            autoFocus
          />
        </div>
        <div style={{ marginBottom: 20 }}>
          <label className="text-xs text-muted" style={{ display: 'block', marginBottom: 6 }}>Description (optional)</label>
          <input
            className="input"
            style={{ width: '100%' }}
            value={desc}
            onChange={e => setDesc(e.target.value)}
            placeholder="Short description…"
          />
        </div>
        <div className="flex gap-2 justify-end">
          <button className="btn btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary btn-sm"
            disabled={!name.trim() || name.trim() === project.name && desc === (project.description ?? '')}
            onClick={save}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Project Card ─────────────────────────────────────────────────────────────

function ProjectCard({ project }: { project: Project }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [renaming, setRenaming] = React.useState(false);
  const menuRef = React.useRef<HTMLDivElement>(null);

  const date = new Date(project.created_at).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });

  // Close menu on outside click
  React.useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setMenuOpen(false);
    if (!window.confirm(`Delete "${project.name}"?\n\nThis removes the project and all uploaded images. This cannot be undone.`)) return;
    await projectsApi.delete(project.id);
    qc.invalidateQueries({ queryKey: ['projects'] });
  };

  const handleDuplicate = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setMenuOpen(false);
    await projectsApi.duplicate(project.id);
    qc.invalidateQueries({ queryKey: ['projects'] });
  };

  return (
    <>
      <div
        className={`card clickable card-status-${project.status}`}
        onClick={() => navigate(`/projects/${project.id}`)}
        style={{ position: 'relative' }}
      >
        {/* Map preview */}
        {project.bbox && (
          <div style={{ margin: '-20px -20px 16px', borderRadius: 'var(--radius-lg) var(--radius-lg) 0 0', overflow: 'hidden' }}>
            <MiniMap bbox={project.bbox} height={130} interactive={false} />
          </div>
        )}

        <div className="flex items-center justify-between mb-3" style={{ gap: 8 }}>
          <h3 className="truncate" style={{ flex: 1, minWidth: 0 }}>{project.name}</h3>
          <StatusBadge status={project.status} />
          {/* ⋮ menu */}
          <div ref={menuRef} style={{ position: 'relative', flexShrink: 0 }} onClick={e => e.stopPropagation()}>
            <button
              className="btn btn-ghost btn-sm"
              style={{ padding: '2px 8px', fontSize: 16, lineHeight: 1, borderRadius: 6 }}
              title="Project actions"
              onClick={e => { e.stopPropagation(); setMenuOpen(v => !v); }}
            >⋮</button>
            {menuOpen && (
              <div style={{
                position: 'absolute', right: 0, top: '100%', marginTop: 4,
                background: 'var(--bg-card)', border: '1px solid var(--border)',
                borderRadius: 10, boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
                minWidth: 160, overflow: 'hidden', zIndex: 100,
              }}>
                {[
                  { icon: '✏️', label: 'Rename', action: (e: React.MouseEvent) => { e.stopPropagation(); setMenuOpen(false); setRenaming(true); } },
                  { icon: '📋', label: 'Duplicate', action: handleDuplicate },
                  { icon: '🗑', label: 'Delete', action: handleDelete, danger: true },
                ].map(item => (
                  <button
                    key={item.label}
                    onClick={item.action}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      width: '100%', padding: '10px 16px',
                      background: 'transparent', border: 'none',
                      color: item.danger ? 'var(--error)' : 'var(--text-primary)',
                      fontSize: 13, cursor: 'pointer', textAlign: 'left',
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-elevated)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    <span>{item.icon}</span>
                    {item.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {project.description && (
          <p className="text-sm mb-3 truncate">{project.description}</p>
        )}

        <div className="flex gap-4 text-xs text-muted">
          <span>🖼 {project.image_count.toLocaleString()} images</span>
          <span>📍 {project.gcp_count} GCPs</span>
          <span>⚙ {project.job_count} jobs</span>
        </div>

        <div className="flex gap-3 text-xs text-muted mt-2">
          {project.area_km2 != null && (
            <span>📐 {project.area_km2.toFixed(3)} km²</span>
          )}
          {project.rtk_mode && project.rtk_mode !== 'none' && (
            <span style={{ color: 'var(--accent)' }}>
              📡 {project.rtk_mode.toUpperCase()}
            </span>
          )}
        </div>

        <div className="separator" />
        <div className="text-xs text-muted">{date}</div>
      </div>

      {renaming && <RenameModal project={project} onClose={() => setRenaming(false)} />}
    </>
  );
}

// ─── Stats rollup ─────────────────────────────────────────────────────────────

function formatArea(km2: number): string {
  if (km2 >= 1) return `${km2.toFixed(2)} km²`;
  return `${(km2 * 1e6).toFixed(0)} m²`;
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const navigate = useNavigate();

  const { data: projects = [], isLoading } = useQuery<Project[]>({
    queryKey: ['projects'],
    queryFn: projectsApi.list,
    refetchInterval: 10000,
  });

  const { data: activeJobs = [] } = useQuery<Job[]>({
    queryKey: ['job-queue'],
    queryFn: () => jobsApi.getQueue(),
    refetchInterval: 5000,
  });

  const { data: recentJobs = [] } = useQuery<Job[]>({
    queryKey: ['jobs-all'],
    queryFn: () => jobsApi.listAll(50),
    refetchInterval: 30000,
  });

  // ── Rollup stats ─────────────────────────────────────────────────────────────
  const totalImages  = projects.reduce((a, p) => a + p.image_count, 0);
  const totalAreaKm2 = projects.reduce((a, p) => a + (p.area_km2 ?? 0), 0);
  const completedJobs = recentJobs.filter(j => j.status === 'completed');
  const avgRmse = (() => {
    const vals = completedJobs.map(j => j.gcp_rmse_total).filter((v): v is number => v != null);
    return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  })();
  const totalProcessingMs = completedJobs.reduce((a, j) => {
    if (!j.started_at || !j.completed_at) return a;
    return a + new Date(j.completed_at).getTime() - new Date(j.started_at).getTime();
  }, 0);
  const totalProcessingHours = totalProcessingMs / 3600000;

  const statTiles = [
    {
      label: 'Total Projects',
      value: projects.length.toString(),
      sub: `${projects.filter(p => p.status === 'processing').length} active`,
      color: 'var(--accent)',
    },
    {
      label: 'Images Processed',
      value: totalImages >= 1000 ? `${(totalImages / 1000).toFixed(1)}k` : totalImages.toString(),
      sub: `across ${projects.length} projects`,
      color: 'var(--info)',
    },
    {
      label: 'Coverage Area',
      value: totalAreaKm2 > 0 ? formatArea(totalAreaKm2) : '—',
      sub: totalAreaKm2 > 0 ? `${(totalAreaKm2 * 247.105).toFixed(0)} acres total` : 'Upload images to estimate',
      color: '#a78bfa',
    },
    {
      label: 'Avg GCP Accuracy',
      value: avgRmse != null ? `${(avgRmse * 100).toFixed(1)} cm` : '—',
      sub: avgRmse != null
        ? avgRmse < 0.03 ? '✓ Survey grade' : avgRmse < 0.08 ? '⚠ Acceptable' : '✕ Review needed'
        : 'No GCP data yet',
      color: avgRmse != null ? avgRmse < 0.03 ? 'var(--success)' : avgRmse < 0.08 ? 'var(--warning)' : 'var(--error)' : 'var(--text-muted)',
    },
    {
      label: 'Completed Jobs',
      value: completedJobs.length.toString(),
      sub: `${totalProcessingHours.toFixed(1)} hrs total compute`,
      color: 'var(--success)',
    },
  ];

  return (
    <div className="page-content">
      <div className="page-header">
        <div className="page-header-left">
          <h1>Dashboard</h1>
          <p className="text-secondary text-sm">Local photogrammetry processing</p>
        </div>
        <button className="btn btn-primary btn-lg" onClick={() => navigate('/projects/new')}>
          ＋ New Project
        </button>
      </div>

      {/* Stats row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 16, marginBottom: 24 }}>
        {statTiles.map(t => (
          <div key={t.label} className="stat-tile">
            <div className="stat-tile-label">{t.label}</div>
            <div className="stat-tile-value" style={{ color: t.color }}>{t.value}</div>
            <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{t.sub}</div>
          </div>
        ))}
      </div>

      {/* Active job ticker */}
      <ActiveJobTicker jobs={activeJobs} projects={projects} />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 280px', gap: 24, alignItems: 'start' }}>
        {/* Projects grid */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2>Projects</h2>
            {projects.length > 0 && (
              <div className="flex gap-2">
                <span className="text-xs text-muted" style={{ alignSelf: 'center' }}>
                  {projects.filter(p => p.status === 'completed').length} completed
                </span>
              </div>
            )}
          </div>
          {isLoading ? (
            <div className="empty-state">
              <div className="animate-pulse">Loading…</div>
            </div>
          ) : projects.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">📷</div>
              <h2>No projects yet</h2>
              <p>Import your drone imagery and start processing</p>
              <button className="btn btn-primary" onClick={() => navigate('/projects/new')}>
                Create your first project
              </button>
            </div>
          ) : (
            <div className="grid-auto">
              {projects.map(p => <ProjectCard key={p.id} project={p} />)}
            </div>
          )}
        </div>

        {/* Sidebar */}
        <div className="flex-col gap-4">
          <HardwareMonitor />
          <div className="card">
            <h4 className="mb-3">Quick Links</h4>
            <div className="flex-col gap-2">
              <button className="btn btn-secondary btn-sm w-full" onClick={() => navigate('/queue')}>
                📋 Job Queue {activeJobs.length > 0 && `(${activeJobs.length})`}
              </button>
              <a href="http://localhost:3000" target="_blank" rel="noreferrer" className="btn btn-secondary btn-sm w-full">
                🔧 NodeODM Dashboard
              </a>
              <button className="btn btn-secondary btn-sm w-full" onClick={() => navigate('/settings')}>
                ⚙ Configure Engine
              </button>
            </div>
          </div>

          {/* Recent completions */}
          {completedJobs.length > 0 && (
            <div className="card">
              <h4 className="mb-3">Recent Completions</h4>
              <div className="flex-col gap-2">
                {completedJobs.slice(0, 5).map(j => {
                  const proj = projects.find(p => p.id === j.project_id);
                  return (
                    <div
                      key={j.id}
                      className="flex items-center gap-2"
                      style={{ cursor: 'pointer', padding: '6px 0' }}
                      onClick={() => navigate(`/projects/${j.project_id}`)}
                    >
                      <span style={{ fontSize: 14 }}>✅</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="text-sm truncate">{proj?.name ?? '—'}</div>
                        <div className="text-xs text-muted">
                          {j.completed_at ? new Date(j.completed_at).toLocaleDateString() : ''}
                        </div>
                      </div>
                      {j.gcp_rmse_total != null && (
                        <span style={{
                          fontSize: 10, fontWeight: 700,
                          color: j.gcp_rmse_total < 0.03 ? 'var(--success)' : j.gcp_rmse_total < 0.08 ? 'var(--warning)' : 'var(--error)',
                        }}>
                          {(j.gcp_rmse_total * 100).toFixed(1)} cm
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
