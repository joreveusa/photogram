/**
 * Queue page — live view of all active processing jobs across all projects.
 * Auto-refreshes every 5 s, with individual progress bars and cancel buttons.
 */

import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { jobsApi, projectsApi, type Job, type Project } from '../api';



// ─── Status colour map ────────────────────────────────────────────────────────

const STATUS_META: Record<string, { color: string; label: string; icon: string }> = {
  queued:    { color: '#818cf8', label: 'Queued',             icon: '⏳' },
  sfm:       { color: '#a78bfa', label: 'Structure from Motion', icon: '📡' },
  splitting: { color: '#60a5fa', label: 'Splitting',          icon: '✂️' },
  dense:     { color: '#3b82f6', label: 'Dense Cloud',        icon: '☁️' },
  merging:   { color: '#f59e0b', label: 'Merging',            icon: '🔗' },
  indexing:  { color: '#00d4aa', label: 'Indexing',           icon: '📦' },
  completed: { color: '#22c55e', label: 'Completed',          icon: '✅' },
  failed:    { color: '#ef4444', label: 'Failed',             icon: '✕' },
};

// ─── Duration helper ─────────────────────────────────────────────────────────

function elapsed(startedAt?: string): string {
  if (!startedAt) return '—';
  const ms = Date.now() - new Date(startedAt).getTime();
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// ─── Single Job Row ───────────────────────────────────────────────────────────

function JobRow({ job, project }: { job: Job; project?: Project }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const meta = STATUS_META[job.status] ?? STATUS_META.queued;

  const cancelMutation = useMutation({
    mutationFn: () => jobsApi.cancel(job.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['job-queue'] });
    },
  });

  const isActive = !['completed', 'failed'].includes(job.status);

  return (
    <div style={{
      background: 'var(--bg-card)',
      border: '1px solid var(--border)',
      borderLeft: `3px solid ${meta.color}`,
      borderRadius: 'var(--radius-lg)',
      padding: '16px 20px',
      transition: 'var(--transition)',
    }}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-3">
          <span style={{ fontSize: 20 }}>{meta.icon}</span>
          <div>
            <div
              className="text-sm font-bold"
              style={{ color: 'var(--text-primary)', cursor: 'pointer' }}
              onClick={() => navigate(`/projects/${job.project_id}`)}
            >
              {project?.name ?? job.project_id.slice(0, 8)}
            </div>
            <div className="text-xs text-muted">
              {job.preset.replace(/_/g, ' ')} · {job.total_images.toLocaleString()} images
              {job.started_at && ` · ⏱ ${elapsed(job.started_at)}`}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <span style={{
            fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 99,
            background: `${meta.color}18`, color: meta.color, border: `1px solid ${meta.color}40`,
          }}>
            {meta.label}
          </span>
          <span style={{ fontSize: 14, fontWeight: 700, color: meta.color, minWidth: 42, textAlign: 'right' }}>
            {job.progress.toFixed(0)}%
          </span>
          {isActive && (
            <button
              className="btn btn-danger btn-sm"
              onClick={() => cancelMutation.mutate()}
              disabled={cancelMutation.isPending}
            >
              {cancelMutation.isPending ? '…' : '✕'}
            </button>
          )}
          <button className="btn btn-secondary btn-sm" onClick={() => navigate(`/projects/${job.project_id}`)}>
            →
          </button>
        </div>
      </div>

      {/* Progress bar */}
      <div className="progress-bar" style={{ height: 4 }}>
        <div
          className={`progress-bar-fill ${isActive ? 'pulsing' : ''}`}
          style={{
            width: `${job.progress}%`,
            background: `linear-gradient(90deg, ${meta.color}99, ${meta.color})`,
            transition: 'width 1s ease-in-out',
          }}
        />
      </div>

      {/* Current step */}
      {job.current_step && (
        <div className="text-xs text-muted mt-2" style={{ paddingLeft: 2 }}>
          {job.current_step}
        </div>
      )}

      {/* Error */}
      {job.status === 'failed' && job.error_message && (
        <div className="text-xs text-error mt-2" style={{ paddingLeft: 2 }}>
          {job.error_message}
        </div>
      )}
    </div>
  );
}

// ─── Queue Page ───────────────────────────────────────────────────────────────

export default function Queue() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: queueJobs = [], isLoading: loadingQueue } = useQuery<Job[]>({
    queryKey: ['job-queue'],
    queryFn: () => jobsApi.getQueue(),
    refetchInterval: 5000,
  });

  const { data: recentJobs = [] } = useQuery<Job[]>({
    queryKey: ['jobs-all'],
    queryFn: () => jobsApi.listAll(20),
    refetchInterval: 15000,
  });

  const { data: projects = [] } = useQuery<Project[]>({
    queryKey: ['projects'],
    queryFn: projectsApi.list,
    refetchInterval: 30000,
  });

  const projectMap = Object.fromEntries(projects.map(p => [p.id, p]));

  const completedRecent = recentJobs.filter(j => j.status === 'completed' || j.status === 'failed').slice(0, 10);

  // Queue summary stats
  const byStatus = queueJobs.reduce((acc: Record<string, number>, j) => {
    acc[j.status] = (acc[j.status] || 0) + 1;
    return acc;
  }, {});

  return (
    <div className="page-content">
      <div className="page-header">
        <div className="page-header-left">
          <h1>Job Queue</h1>
          <p className="text-secondary text-sm">
            {queueJobs.length === 0 ? 'No active jobs' : `${queueJobs.length} active job${queueJobs.length !== 1 ? 's' : ''}`}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => {
              queryClient.invalidateQueries({ queryKey: ['job-queue'] });
              queryClient.invalidateQueries({ queryKey: ['jobs-all'] });
            }}
          >
            ↻ Refresh
          </button>
          <button className="btn btn-primary" onClick={() => navigate('/projects/new')}>
            ＋ New Project
          </button>
        </div>
      </div>

      {/* Status summary tiles */}
      {queueJobs.length > 0 && (
        <div className="flex gap-3 mb-6 flex-wrap">
          {Object.entries(byStatus).map(([status, count]) => {
            const m = STATUS_META[status] ?? STATUS_META.queued;
            return (
              <div key={status} style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '8px 14px', borderRadius: 'var(--radius-lg)',
                background: `${m.color}12`, border: `1px solid ${m.color}30`,
              }}>
                <span>{m.icon}</span>
                <span style={{ color: m.color, fontWeight: 700, fontSize: 18 }}>{count}</span>
                <span className="text-xs text-muted">{m.label}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* Active jobs */}
      <div className="mb-6">
        <h2 className="mb-4">Active</h2>
        {loadingQueue ? (
          <div className="empty-state">
            <div className="animate-pulse text-muted">Loading queue…</div>
          </div>
        ) : queueJobs.length === 0 ? (
          <div className="empty-state card">
            <div className="empty-state-icon">✅</div>
            <h2>Queue is empty</h2>
            <p>All jobs have completed. Start a new project to add to the queue.</p>
            <button className="btn btn-primary mt-4" onClick={() => navigate('/projects/new')}>
              New Project
            </button>
          </div>
        ) : (
          <div className="flex-col gap-3">
            {queueJobs.map(j => (
              <JobRow key={j.id} job={j} project={projectMap[j.project_id]} />
            ))}
          </div>
        )}
      </div>

      {/* Recent history */}
      {completedRecent.length > 0 && (
        <div>
          <h2 className="mb-4">Recent History</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Preset</th>
                  <th>Images</th>
                  <th>Status</th>
                  <th>GCP RMSE</th>
                  <th>Duration</th>
                  <th>Completed</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {completedRecent.map(j => {
                  const project = projectMap[j.project_id];
                  const meta = STATUS_META[j.status];
                  const duration = j.started_at && j.completed_at
                    ? elapsed(j.started_at)  // reuse as "was running for"
                    : '—';
                  return (
                    <tr key={j.id}>
                      <td style={{ fontWeight: 600 }}>
                        <span
                          style={{ cursor: 'pointer', color: 'var(--accent)' }}
                          onClick={() => navigate(`/projects/${j.project_id}`)}
                        >
                          {project?.name ?? j.project_id.slice(0, 8)}
                        </span>
                      </td>
                      <td className="text-muted">{j.preset.replace(/_/g, ' ')}</td>
                      <td>{j.total_images.toLocaleString()}</td>
                      <td>
                        <span style={{
                          fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 99,
                          background: `${meta.color}18`, color: meta.color,
                        }}>
                          {meta.icon} {meta.label}
                        </span>
                      </td>
                      <td style={{ color: j.gcp_rmse_total != null
                        ? j.gcp_rmse_total < 0.03 ? 'var(--success)' : j.gcp_rmse_total < 0.08 ? 'var(--warning)' : 'var(--error)'
                        : 'var(--text-muted)',
                        fontFamily: 'monospace', fontSize: 12,
                      }}>
                        {j.gcp_rmse_total != null ? `${(j.gcp_rmse_total * 100).toFixed(1)} cm` : '—'}
                      </td>
                      <td className="text-muted">{duration}</td>
                      <td className="text-muted text-xs">
                        {j.completed_at ? new Date(j.completed_at).toLocaleDateString() : '—'}
                      </td>
                      <td>
                        <div className="flex gap-2">
                          <button className="btn btn-ghost btn-sm" onClick={() => navigate(`/projects/${j.project_id}`)}>
                            View
                          </button>
                          {j.status === 'completed' && (
                            <button
                              className="btn btn-secondary btn-sm"
                              onClick={() => navigate(`/report/${j.id}`)}
                            >
                              📄 Report
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
