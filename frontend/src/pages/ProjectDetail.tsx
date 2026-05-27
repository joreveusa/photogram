import { useEffect, useState, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { projectsApi, jobsApi, createJobWebSocket, type Job, type JobOutput, type Project, type GCPReport } from '../api';
import GCPEditor from '../components/GCPEditor';
import ImageGallery from '../components/ImageGallery';
import { useToast } from '../hooks/useToast';
import { useNotification } from '../hooks/useNotification';

// ─── Status Badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`badge badge-${status}`}>
      <span className="badge-dot" />
      {status.replace(/_/g, ' ').charAt(0).toUpperCase() + status.replace(/_/g, ' ').slice(1)}
    </span>
  );
}

// ─── Step Log Entry ────────────────────────────────────────────────────────────

interface StepEntry {
  ts: number;
  message: string;
  status: string;
  progress: number;
}

// ─── Pipeline Timeline ────────────────────────────────────────────────────────

const PIPELINE_STEPS = [
  { key: 'queued',    icon: '⏳', label: 'Queued',               desc: 'Job waiting in processing queue' },
  { key: 'sfm',       icon: '📡', label: 'Structure from Motion', desc: 'Computing camera positions across all images' },
  { key: 'splitting', icon: '✂️', label: 'Splitting',             desc: 'Dividing project into geographic submodels' },
  { key: 'dense',     icon: '☁️', label: 'Dense Point Cloud',     desc: 'Generating depth maps and dense reconstruction' },
  { key: 'merging',   icon: '🔗', label: 'Merging',               desc: 'Stitching submodels into unified deliverables' },
  { key: 'indexing',  icon: '📦', label: 'Indexing Outputs',      desc: 'Packaging orthomosaic, point cloud, and mesh' },
  { key: 'completed', icon: '✅', label: 'Completed',             desc: 'All outputs ready for download and viewing' },
];

function PipelineTimeline({ job }: { job: Job }) {
  const statusOrder = ['queued', 'sfm', 'splitting', 'dense', 'merging', 'indexing', 'completed', 'failed'];

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h3>Processing Pipeline</h3>
        <StatusBadge status={job.status} />
      </div>

      {/* Progress bar */}
      {job.status !== 'completed' && job.status !== 'failed' && (
        <div className="mb-4">
          <div className="flex justify-between text-xs text-muted mb-1">
            <span>{job.current_step || 'Processing…'}</span>
            <span>{job.progress.toFixed(0)}%</span>
          </div>
          <div className="progress-bar">
            <div
              className="progress-bar-fill pulsing"
              style={{ width: `${job.progress}%`, transition: 'width 0.8s ease-in-out' }}
            />
          </div>
        </div>
      )}

      {/* Completed summary */}
      {job.status === 'completed' && job.completed_at && job.started_at && (
        <div className="mb-4 text-xs text-accent" style={{
          background: 'rgba(0,212,170,0.07)', borderRadius: 8,
          padding: '8px 12px', border: '1px solid rgba(0,212,170,0.2)',
        }}>
          ✅ Completed in {formatDuration(job.started_at, job.completed_at)}
        </div>
      )}

      <div className="timeline">
        {PIPELINE_STEPS.map((s, i) => {
          const stepIdx = statusOrder.indexOf(s.key);
          const isDone    = stepIdx < statusOrder.indexOf(job.status) && job.status !== 'failed';
          const isActive  = s.key === job.status;
          const isFailed  = job.status === 'failed' && s.key === statusOrder[statusOrder.indexOf(job.status) - 1];

          return (
            <div key={s.key} className="timeline-item">
              <div className="timeline-icon-wrap">
                <div className={`timeline-icon ${isActive ? 'active' : ''} ${isDone ? 'done' : ''} ${isFailed ? 'failed' : ''}`}>
                  {isActive ? <span className="animate-spin" style={{ display: 'inline-block' }}>⟳</span>
                    : isDone ? '✓'
                    : isFailed ? '✕'
                    : s.icon}
                </div>
                {i < PIPELINE_STEPS.length - 1 && (
                  <div className={`timeline-line ${isDone ? 'done' : ''}`} />
                )}
              </div>
              <div className="timeline-body">
                <h3 style={{ color: isActive ? 'var(--accent)' : isDone ? 'var(--success)' : 'var(--text-secondary)' }}>
                  {s.label}
                </h3>
                <p>{s.desc}</p>
              </div>
            </div>
          );
        })}
      </div>

      {job.status === 'failed' && job.error_message && (
        <div className="card mt-4" style={{ borderColor: 'var(--error)', background: 'rgba(239,68,68,0.08)' }}>
          <div className="text-error font-bold mb-1">Processing Failed</div>
          <code className="text-xs text-secondary">{job.error_message}</code>
        </div>
      )}
    </div>
  );
}

// ─── Live Log ─────────────────────────────────────────────────────────────────

function LiveLog({ entries }: { entries: StepEntry[] }) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entries]);

  if (entries.length === 0) return null;

  return (
    <div className="card mt-4" style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{
        background: 'var(--bg-secondary)', padding: '10px 16px',
        borderBottom: '1px solid var(--border)', display: 'flex',
        justifyContent: 'space-between', alignItems: 'center',
      }}>
        <span className="text-xs font-bold" style={{ color: 'var(--text-muted)', letterSpacing: '0.05em', textTransform: 'uppercase' }}>
          Live Log
        </span>
        <span className="text-xs text-muted">{entries.length} events</span>
      </div>
      <div style={{
        fontFamily: 'ui-monospace, monospace', fontSize: 11,
        maxHeight: 220, overflowY: 'auto', padding: '8px 0',
        background: 'var(--bg-primary)',
      }}>
        {entries.map((e, i) => (
          <div key={i} style={{
            padding: '3px 16px', display: 'flex', gap: 12,
            borderLeft: `2px solid ${e.status === 'completed' ? 'var(--success)' : e.status === 'failed' ? 'var(--error)' : 'var(--border)'}`,
            marginLeft: 8, marginBottom: 2,
          }}>
            <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>{new Date(e.ts).toLocaleTimeString()}</span>
            <span style={{ color: 'var(--accent)', width: 36, flexShrink: 0, textAlign: 'right' }}>{e.progress.toFixed(0)}%</span>
            <span style={{ color: 'var(--text-primary)' }}>{e.message}</span>
          </div>
        ))}
        <div ref={endRef} />
      </div>
    </div>
  );
}

// ─── Outputs Panel ────────────────────────────────────────────────────────────

function OutputsPanel({ jobId }: { jobId: string }) {
  const navigate = useNavigate();
  const { data: outputs = [] } = useQuery<JobOutput[]>({
    queryKey: ['job-outputs', jobId],
    queryFn: () => jobsApi.getOutputs(jobId),
    refetchInterval: 5000,
  });

  const outputMeta: Record<string, { icon: string; label: string; color: string }> = {
    orthomosaic: { icon: '🗺',  label: 'Orthomosaic (GeoTIFF)',  color: 'var(--info)' },
    point_cloud: { icon: '☁️', label: 'Point Cloud (LAZ)',       color: 'var(--accent)' },
    mesh:        { icon: '🔷', label: '3D Mesh (OBJ)',           color: '#a78bfa' },
    mesh_glb:    { icon: '🔷', label: '3D Mesh (GLB)',           color: '#c084fc' },
    dsm:         { icon: '⛰',  label: 'Digital Surface Model',   color: 'var(--warning)' },
    report:      { icon: '📄', label: 'Processing Report',        color: 'var(--text-secondary)' },
    ept:         { icon: '✨', label: 'Point Cloud (Potree EPT)', color: 'var(--accent)' },
  };

  if (outputs.length === 0) return null;

  const formatSize = (bytes?: number) => {
    if (!bytes) return '—';
    if (bytes > 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
    if (bytes > 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
    return `${(bytes / 1e3).toFixed(0)} KB`;
  };

  const viewable = outputs.filter(o => ['mesh', 'mesh_glb', 'point_cloud', 'ept'].includes(o.output_type));

  return (
    <div className="card mt-4">
      <div className="flex items-center justify-between mb-4">
        <h3>Outputs</h3>
        <div className="flex gap-2">
          {outputs.some(o => o.output_type === 'orthomosaic') && (
            <button className="btn btn-secondary btn-sm" onClick={() => navigate(`/ortho/${jobId}`)}>
              🗺 Ortho View
            </button>
          )}
          {viewable.length > 0 && (
            <button className="btn btn-primary btn-sm" onClick={() => navigate(`/viewer/${jobId}`)}>
              👁 3D Viewer
            </button>
          )}
        </div>
      </div>
      <div className="flex-col gap-2">
        {outputs.filter(o => o.output_type !== 'ept').map(o => {
          const meta = outputMeta[o.output_type] || { icon: '📁', label: o.output_type, color: 'var(--text-secondary)' };
          return (
            <div key={o.id} className="flex items-center justify-between" style={{
              background: 'var(--bg-secondary)', padding: '12px 16px',
              borderRadius: 'var(--radius-md)', border: '1px solid var(--border)',
            }}>
              <div className="flex items-center gap-3">
                <span style={{ fontSize: 20 }}>{meta.icon}</span>
                <div>
                  <div className="text-sm" style={{ color: meta.color }}>{meta.label}</div>
                  <div className="text-xs text-muted">{formatSize(o.file_size_bytes)}</div>
                </div>
              </div>
              <div className="flex gap-2">
                {viewable.some(v => v.id === o.id) && (
                  <button className="btn btn-secondary btn-sm" onClick={() => navigate(`/viewer/${jobId}`)}>
                    👁 View
                  </button>
                )}
                <a
                  href={`http://localhost:8000/jobs/${jobId}/download/${o.output_type}`}
                  className="btn btn-ghost btn-sm"
                  download
                >
                  ↓ Download
                </a>
              </div>
            </div>
          );
        })}

        {/* EPT badge — no download, just indicates Potree stream is available */}
        {outputs.find(o => o.output_type === 'ept') && (
          <div style={{
            padding: '10px 16px', borderRadius: 'var(--radius-md)',
            background: 'rgba(0,212,170,0.07)', border: '1px solid rgba(0,212,170,0.25)',
            display: 'flex', alignItems: 'center', gap: 12,
          }}>
            <span style={{ fontSize: 20 }}>✨</span>
            <div>
              <div className="text-sm" style={{ color: 'var(--accent)' }}>Potree Streaming Ready</div>
              <div className="text-xs text-muted">Open the 3D Viewer to explore the point cloud interactively</div>
            </div>
            <button className="btn btn-secondary btn-sm ml-auto" onClick={() => navigate(`/viewer/${jobId}`)}>
              Launch
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── GCP Accuracy Panel ───────────────────────────────────────────────────────

function GCPAccuracyPanel({ jobId }: { jobId: string; job: Job }) {
  const queryClient = useQueryClient();
  const [parsing, setParsing] = useState(false);

  const { data: report } = useQuery<GCPReport>({
    queryKey: ['gcp-report', jobId],
    queryFn: () => jobsApi.getGcpReport(jobId),
    enabled: !!jobId,
    retry: false,
  });

  const hasAnyError = report?.gcps.some(g => g.error_total != null);

  const rmseColor = (v?: number) => {
    if (v == null) return 'var(--text-muted)';
    if (v < 0.03) return 'var(--success)';
    if (v < 0.08) return 'var(--warning)';
    return 'var(--error)';
  };

  const handleParseReport = async () => {
    setParsing(true);
    try {
      await jobsApi.parseReport(jobId);
      queryClient.invalidateQueries({ queryKey: ['gcp-report', jobId] });
    } catch { /* non-fatal */ }
    finally { setParsing(false); }
  };

  const fmt = (v?: number) => v != null ? `${(v * 100).toFixed(1)} cm` : '—';

  return (
    <div className="card mt-4">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3>GCP Accuracy Report</h3>
          {report?.rmse_total != null && (
            <div className="text-xs mt-1" style={{ color: rmseColor(report.rmse_total) }}>
              Overall RMSE: <strong>{fmt(report.rmse_total)}</strong>
              {report.rmse_total < 0.03 ? ' ✓ Survey grade' : report.rmse_total < 0.08 ? ' ⚠ Acceptable' : ' ✕ Review required'}
            </div>
          )}
        </div>
        {(!hasAnyError) && (
          <button className="btn btn-secondary btn-sm" onClick={handleParseReport} disabled={parsing}>
            {parsing ? '⟳ Parsing…' : '↻ Parse Report'}
          </button>
        )}
      </div>

      {/* Overall RMSE summary */}
      {report?.rmse_x != null && (
        <div className="grid-4 mb-4">
          {[
            { label: 'X (Easting)',  val: report.rmse_x },
            { label: 'Y (Northing)', val: report.rmse_y },
            { label: 'Z (Vertical)', val: report.rmse_z },
            { label: 'Total RMSE',   val: report.rmse_total },
          ].map(({ label, val }) => (
            <div key={label} className="stat-tile" style={{ padding: '10px 14px' }}>
              <div className="stat-tile-label">{label}</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: rmseColor(val), marginTop: 4 }}>
                {fmt(val)}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Per-GCP table */}
      {hasAnyError ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>GCP Label</th>
                <th>Coordinates</th>
                <th>Error X</th>
                <th>Error Y</th>
                <th>Error Z</th>
                <th>Total</th>
                <th>Rating</th>
              </tr>
            </thead>
            <tbody>
              {report!.gcps.filter(g => g.error_total != null).map(g => (
                <tr key={g.label}>
                  <td style={{ fontWeight: 600 }}>{g.label}</td>
                  <td style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--text-muted)' }}>
                    {g.x.toFixed(3)}, {g.y.toFixed(3)}, {g.z.toFixed(3)}
                  </td>
                  <td style={{ color: rmseColor(g.error_x) }}>{fmt(g.error_x)}</td>
                  <td style={{ color: rmseColor(g.error_y) }}>{fmt(g.error_y)}</td>
                  <td style={{ color: rmseColor(g.error_z) }}>{fmt(g.error_z)}</td>
                  <td style={{ fontWeight: 700, color: rmseColor(g.error_total) }}>{fmt(g.error_total)}</td>
                  <td>
                    <span style={{
                      fontSize: 10, padding: '2px 8px', borderRadius: 99, fontWeight: 700,
                      background: (g.error_total ?? 1) < 0.03 ? 'rgba(34,197,94,0.15)' : (g.error_total ?? 1) < 0.08 ? 'rgba(245,158,11,0.15)' : 'rgba(239,68,68,0.15)',
                      color: rmseColor(g.error_total),
                    }}>
                      {(g.error_total ?? 1) < 0.03 ? 'Excellent' : (g.error_total ?? 1) < 0.08 ? 'OK' : 'Review'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="text-xs text-muted" style={{ textAlign: 'center', padding: '20px 0' }}>
          {report ? 'No per-GCP error data in this report.' : 'Click "Parse Report" to extract GCP accuracy from the NodeODM report.'}
        </div>
      )}
    </div>
  );
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function formatDuration(start: string, end: string): string {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// ─── Project Detail ───────────────────────────────────────────────────────────

export default function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { notifyJobComplete } = useNotification();
  const [liveJob, setLiveJob] = useState<Job | null>(null);
  const [stepLog, setStepLog] = useState<StepEntry[]>([]);
  const lastStepRef = useRef<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { data: project } = useQuery<Project>({
    queryKey: ['project', id],
    queryFn: () => projectsApi.get(id!),
    refetchInterval: 15000,
  });

  const { data: jobs = [] } = useQuery<Job[]>({
    queryKey: ['jobs', id],
    queryFn: () => jobsApi.listByProject(id!),
    refetchInterval: 10000,
  });

  const latestJob = liveJob || jobs[0];

  // ── WebSocket with reconnect ───────────────────────────────────────────────
  const connectWs = useCallback((jobId: string) => {
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.close();
    }

    const ws = createJobWebSocket(jobId, (job) => {
      setLiveJob(prev => {
        // Fire desktop notification on first transition to terminal state
        if (prev && prev.status !== job.status) {
          if (job.status === 'completed' || job.status === 'failed') {
            const name = project?.name ?? 'Project';
            const dur = job.started_at && job.completed_at
              ? formatDuration(job.started_at, job.completed_at)
              : undefined;
            notifyJobComplete(name, job.status, dur);
          }
        }
        return job;
      });
      queryClient.invalidateQueries({ queryKey: ['jobs', id] });

      // Append to live log if step changed
      if (job.current_step && job.current_step !== lastStepRef.current) {
        lastStepRef.current = job.current_step;
        setStepLog(prev => [...prev.slice(-99), {
          ts: Date.now(),
          message: job.current_step!,
          status: job.status,
          progress: job.progress,
        }]);
      }
    });

    ws.onclose = () => {
      // Reconnect after 5 s if the job is still active
      reconnectTimer.current = setTimeout(() => {
        setLiveJob(cur => {
          if (cur && cur.status !== 'completed' && cur.status !== 'failed') {
            connectWs(jobId);
          }
          return cur;
        });
      }, 5000);
    };

    wsRef.current = ws;
  }, [id, queryClient]);

  useEffect(() => {
    const job = liveJob || jobs[0];
    if (!job || job.status === 'completed' || job.status === 'failed') return;
    connectWs(job.id);
    return () => {
      wsRef.current?.close();
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    };
  }, [(liveJob || jobs[0])?.id, (liveJob || jobs[0])?.status]);

  const cancelMutation = useMutation({
    mutationFn: () => jobsApi.cancel(latestJob!.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['jobs', id] });
      toast.warning('Job cancelled', 'Processing has been stopped');
    },
    onError: (e: any) => toast.error('Cancel failed', e?.message),
  });

  if (!project) {
    return <div className="page-content"><div className="animate-pulse text-muted">Loading…</div></div>;
  }

  return (
    <div className="page-content">
      <div className="page-header">
        <div className="page-header-left">
          <div className="flex items-center gap-3">
            <button className="btn btn-ghost btn-sm" onClick={() => navigate('/')}>← Back</button>
            <h1>{project.name}</h1>
            <span className={`badge badge-${project.status}`}>
              <span className="badge-dot" />
              {project.status.charAt(0).toUpperCase() + project.status.slice(1)}
            </span>
          </div>
          {project.description && <p className="text-secondary text-sm">{project.description}</p>}
        </div>
        <div className="flex gap-2">
          {latestJob && ['queued', 'sfm', 'dense', 'merging', 'indexing'].includes(latestJob.status) && (
            <button className="btn btn-danger btn-sm" onClick={() => cancelMutation.mutate()}>
              ✕ Cancel Job
            </button>
          )}
          {(project.status === 'completed' || project.status === 'failed') && (
            <button className="btn btn-secondary" onClick={() => navigate(`/projects/new`)}>
              ↻ New Job
            </button>
          )}
        </div>
      </div>

      {/* Info tiles */}
      <div className="grid-4 mb-6">
        <div className="stat-tile">
          <div className="stat-tile-label">Images</div>
          <div className="stat-tile-value">{project.image_count.toLocaleString()}</div>
        </div>
        <div className="stat-tile">
          <div className="stat-tile-label">GCPs</div>
          <div className="stat-tile-value">{project.gcp_count}</div>
        </div>
        <div className="stat-tile">
          <div className="stat-tile-label">Coordinate System</div>
          <div className="stat-tile-value font-mono" style={{ fontSize: 16 }}>
            {project.coordinate_system || '—'}
          </div>
        </div>
        <div className="stat-tile">
          <div className="stat-tile-label">Processing Jobs</div>
          <div className="stat-tile-value">{project.job_count}</div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 24, alignItems: 'start' }}>
        <div>
          {latestJob ? (
            <>
              <div className="card">
                <PipelineTimeline job={latestJob} />
              </div>
              <LiveLog entries={stepLog} />
              <OutputsPanel jobId={latestJob.id} />
              {latestJob.status === 'completed' && (project?.gcp_count ?? 0) > 0 && (
                <GCPAccuracyPanel jobId={latestJob.id} job={latestJob} />
              )}
            </>
          ) : (
            <div className="empty-state card">
              <div className="empty-state-icon">🚀</div>
              <h2>No processing jobs yet</h2>
              <p>Start a processing job to generate your deliverables</p>
            </div>
          )}

          {/* GCP Editor — always visible so user can add GCPs before processing */}
          <div className="mt-4">
            <GCPEditor projectId={id!} gcpCount={project.gcp_count} />
          </div>

          {/* Image Gallery */}
          <div className="mt-4">
            <ImageGallery projectId={id!} imageCount={project.image_count} />
          </div>
        </div>

        {/* Job sidebar */}
        <div className="flex-col gap-4">
          {latestJob && (
            <div className="card">
              <h4 className="mb-3">Job Details</h4>
              <div className="flex-col gap-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted">Preset</span>
                  <span>{latestJob.preset?.replace(/_/g, ' ') ?? latestJob.preset}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted">Images</span>
                  <span>{latestJob.total_images.toLocaleString()}</span>
                </div>
                {latestJob.started_at && (
                  <div className="flex justify-between">
                    <span className="text-muted">Started</span>
                    <span>{new Date(latestJob.started_at).toLocaleTimeString()}</span>
                  </div>
                )}
                {latestJob.completed_at && (
                  <div className="flex justify-between">
                    <span className="text-muted">Completed</span>
                    <span>{new Date(latestJob.completed_at).toLocaleTimeString()}</span>
                  </div>
                )}
                {latestJob.started_at && latestJob.completed_at && (
                  <div className="flex justify-between">
                    <span className="text-muted">Duration</span>
                    <span className="text-accent">{formatDuration(latestJob.started_at, latestJob.completed_at)}</span>
                  </div>
                )}
                {latestJob.nodeodm_task_id && (
                  <div>
                    <span className="text-muted">NodeODM Task</span>
                    <div className="font-mono text-xs text-accent mt-1">{latestJob.nodeodm_task_id}</div>
                  </div>
                )}
              </div>

              {/* WS connection indicator */}
              {latestJob.status !== 'completed' && latestJob.status !== 'failed' && (
                <div className="flex items-center gap-2 mt-3 pt-3" style={{ borderTop: '1px solid var(--border)' }}>
                  <div style={{
                    width: 7, height: 7, borderRadius: '50%',
                    background: 'var(--accent)',
                    boxShadow: '0 0 6px var(--accent)',
                    animation: 'pulse 2s ease-in-out infinite',
                  }} />
                  <span className="text-xs text-muted">Live updates active</span>
                </div>
              )}
            </div>
          )}

          {jobs.length > 1 && (
            <div className="card">
              <h4 className="mb-3">Job History</h4>
              <div className="flex-col gap-2">
                {jobs.map(j => (
                  <div key={j.id} className="flex items-center justify-between text-sm" style={{
                    padding: '8px 12px', background: 'var(--bg-secondary)',
                    borderRadius: 'var(--radius-md)',
                  }}>
                    <div>
                      <div>{new Date(j.created_at).toLocaleDateString()}</div>
                      <div className="text-xs text-muted">{j.preset?.replace(/_/g, ' ') ?? j.preset}</div>
                    </div>
                    <StatusBadge status={j.status} />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
