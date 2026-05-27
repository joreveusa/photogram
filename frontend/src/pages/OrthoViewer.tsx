/**
 * OrthoViewer — spatial context viewer for a completed job.
 * Shows the project bbox on a Leaflet map, job stats, all outputs,
 * and GCP RMSE. Links to print report. Supports downloading deliverables.
 *
 * Route: /ortho/:jobId
 */

import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  jobsApi, projectsApi,
  type Job, type Project, type JobOutput, type GCPReport,
} from '../api';
import MiniMap from '../components/MiniMap';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtSize(bytes?: number): string {
  if (!bytes) return '—';
  if (bytes > 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes > 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e3).toFixed(0)} KB`;
}

function fmtDate(iso?: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function duration(start?: string, end?: string): string {
  if (!start || !end) return '—';
  const ms = new Date(end).getTime() - new Date(start).getTime();
  const h  = Math.floor(ms / 3600000);
  const m  = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function rmseColor(v?: number): string {
  if (v == null) return 'var(--text-muted)';
  if (v < 0.03) return 'var(--success)';
  if (v < 0.08) return 'var(--warning)';
  return 'var(--error)';
}

const OUTPUT_META: Record<string, { icon: string; label: string; color: string }> = {
  orthomosaic: { icon: '🗺', label: 'Orthomosaic (GeoTIFF)', color: '#60a5fa' },
  point_cloud: { icon: '☁️', label: 'Point Cloud (LAZ)',    color: '#a78bfa' },
  mesh:        { icon: '🔺', label: '3D Mesh (OBJ)',         color: '#f59e0b' },
  mesh_glb:    { icon: '🔷', label: '3D Mesh (GLB)',         color: '#00d4aa' },
  dsm:         { icon: '⛰', label: 'DSM (GeoTIFF)',          color: '#22c55e' },
  report:      { icon: '📄', label: 'Report (PDF)',           color: '#e2e8f0' },
  ept:         { icon: '🌐', label: 'Point Cloud (Potree)',   color: '#818cf8' },
};

// ─── Output card ─────────────────────────────────────────────────────────────

function OutputCard({ output, jobId }: { output: JobOutput; jobId: string }) {
  const meta = OUTPUT_META[output.output_type] ?? {
    icon: '📁', label: output.output_type, color: 'var(--text-muted)',
  };

  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '12px 16px',
      background: 'var(--bg-elevated)', borderRadius: 'var(--radius-md)',
      border: '1px solid var(--border)',
    }}>
      <div className="flex items-center gap-3">
        <span style={{ fontSize: 22 }}>{meta.icon}</span>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: meta.color }}>{meta.label}</div>
          <div className="text-xs text-muted">{fmtSize(output.file_size_bytes)}</div>
        </div>
      </div>
      <a
        href={`${API_URL}/jobs/${jobId}/download/${output.output_type}`}
        className="btn btn-secondary btn-sm"
        download
      >
        ↓ Download
      </a>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function OrthoViewer() {
  const { jobId } = useParams<{ jobId: string }>();
  const navigate  = useNavigate();

  const { data: job } = useQuery<Job>({
    queryKey: ['job', jobId],
    queryFn:  () => jobsApi.get(jobId!),
    enabled:  !!jobId,
  });

  const { data: project } = useQuery<Project>({
    queryKey: ['project', job?.project_id],
    queryFn:  () => projectsApi.get(job!.project_id),
    enabled:  !!job?.project_id,
  });

  const { data: outputs = [] } = useQuery<JobOutput[]>({
    queryKey: ['job-outputs', jobId],
    queryFn:  () => jobsApi.getOutputs(jobId!),
    enabled:  !!jobId,
  });

  const { data: report } = useQuery<GCPReport>({
    queryKey: ['gcp-report', jobId],
    queryFn:  () => jobsApi.getGcpReport(jobId!),
    enabled:  !!jobId,
    retry: false,
  });

  if (!job || !project) {
    return (
      <div className="page-content">
        <div className="animate-pulse text-muted">Loading…</div>
      </div>
    );
  }

  const hasOrtho    = outputs.some(o => o.output_type === 'orthomosaic');
  const hasEpt      = outputs.some(o => o.output_type === 'ept');
  const totalSizeGB = outputs.reduce((s, o) => s + (o.file_size_bytes ?? 0), 0) / 1e9;

  return (
    <div className="page-content">
      {/* Header */}
      <div className="page-header">
        <div className="page-header-left">
          <div className="flex items-center gap-3 mb-1">
            <button className="btn btn-ghost btn-sm" onClick={() => navigate(`/projects/${project.id}`)}>
              ← Project
            </button>
            <h1>🗺 {project.name}</h1>
            <span className="badge badge-completed">
              <span className="badge-dot" /> Completed
            </span>
          </div>
          <p className="text-secondary text-sm">
            {job.total_images.toLocaleString()} images · {job.preset.replace(/_/g, ' ')} · {fmtDate(job.completed_at)}
          </p>
        </div>
        <div className="flex gap-2">
          {hasEpt && (
            <button className="btn btn-primary" onClick={() => navigate(`/viewer/${jobId}`)}>
              👁 3D Viewer
            </button>
          )}
          <button className="btn btn-secondary" onClick={() => navigate(`/report/${jobId}`)}>
            📄 Accuracy Report
          </button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 24, alignItems: 'start' }}>
        {/* Left — map + outputs */}
        <div className="flex-col gap-4">
          {/* Map */}
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            {project.bbox ? (
              <MiniMap bbox={project.bbox} height={380} interactive={true} />
            ) : (
              <div style={{
                height: 380, display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'var(--bg-secondary)', color: 'var(--text-muted)', fontSize: 14,
              }}>
                No location data — upload images with GPS tags to see the map
              </div>
            )}
            {project.bbox && (
              <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border)' }}>
                <div className="flex gap-4 text-xs text-muted">
                  {project.area_km2 != null && (
                    <span>📐 {project.area_km2.toFixed(4)} km² ({(project.area_km2 * 247.105).toFixed(1)} acres)</span>
                  )}
                  <span>📍 {project.bbox.min_lat.toFixed(4)}°, {project.bbox.min_lon.toFixed(4)}°</span>
                  {project.coordinate_system && (
                    <span>{project.coordinate_system}</span>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Deliverables */}
          <div className="card">
            <div className="flex items-center justify-between mb-4">
              <h3>Deliverables</h3>
              <span className="text-xs text-muted">{totalSizeGB.toFixed(2)} GB total</span>
            </div>
            {outputs.length === 0 ? (
              <div className="text-sm text-muted">No outputs found. Register outputs from the project page.</div>
            ) : (
              <div className="flex-col gap-2">
                {outputs.map(o => <OutputCard key={o.id} output={o} jobId={jobId!} />)}
              </div>
            )}
          </div>

          {/* GeoTIFF info box */}
          {hasOrtho && (
            <div className="card" style={{ borderColor: 'rgba(96,165,250,0.25)', background: 'rgba(96,165,250,0.04)' }}>
              <h4 className="mb-2">🗺 Viewing the Orthomosaic</h4>
              <p className="text-sm text-secondary mb-3">
                The orthomosaic is a georeferenced GeoTIFF that can be opened directly in GIS software:
              </p>
              <div className="flex-col gap-2 text-xs text-muted">
                <div>• <strong style={{ color: 'var(--text-secondary)' }}>QGIS</strong>: Layer → Add Raster Layer → select the downloaded .tif</div>
                <div>• <strong style={{ color: 'var(--text-secondary)' }}>ArcGIS Pro</strong>: Add Data → Raster Dataset</div>
                <div>• <strong style={{ color: 'var(--text-secondary)' }}>Global Mapper</strong>: File → Open Data Files</div>
                <div>• <strong style={{ color: 'var(--text-secondary)' }}>Python</strong>: <code>rasterio.open('orthomosaic.tif')</code></div>
              </div>
            </div>
          )}
        </div>

        {/* Right sidebar */}
        <div className="flex-col gap-4">
          {/* Job stats */}
          <div className="card">
            <h4 className="mb-3">Job Statistics</h4>
            <div className="flex-col gap-2 text-sm">
              {[
                { label: 'Images',         value: job.total_images.toLocaleString() },
                { label: 'Preset',         value: job.preset.replace(/_/g, ' ') },
                { label: 'Started',        value: fmtDate(job.started_at) },
                { label: 'Duration',       value: duration(job.started_at, job.completed_at) },
                { label: 'Outputs',        value: `${outputs.length} files` },
                ...(project.rtk_mode && project.rtk_mode !== 'none' ? [
                  { label: 'GPS Mode',     value: project.rtk_mode.toUpperCase() },
                ] : []),
              ].map(({ label, value }) => (
                <div key={label} className="flex justify-between">
                  <span className="text-muted">{label}</span>
                  <span style={{ fontWeight: 500 }}>{value}</span>
                </div>
              ))}
            </div>
          </div>

          {/* GCP accuracy */}
          {report?.rmse_total != null && (
            <div className="card" style={{ borderColor: `${rmseColor(report.rmse_total)}30` }}>
              <h4 className="mb-3">GCP Accuracy</h4>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                {[
                  { label: 'X RMSE', val: report.rmse_x },
                  { label: 'Y RMSE', val: report.rmse_y },
                  { label: 'Z RMSE', val: report.rmse_z },
                  { label: 'Total',  val: report.rmse_total },
                ].map(({ label, val }) => (
                  <div key={label} style={{
                    background: 'var(--bg-elevated)', borderRadius: 8,
                    padding: '10px 12px', border: '1px solid var(--border)',
                  }}>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4 }}>{label}</div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: rmseColor(val), fontFamily: 'monospace' }}>
                      {val != null ? `${(val * 100).toFixed(1)} cm` : '—'}
                    </div>
                  </div>
                ))}
              </div>
              <div className="text-xs mt-3" style={{ color: rmseColor(report.rmse_total) }}>
                {report.rmse_total < 0.03 ? '✓ Survey grade accuracy' :
                 report.rmse_total < 0.08 ? '⚠ Acceptable mapping accuracy' :
                 '✕ Consider additional GCPs'}
              </div>
              <button
                className="btn btn-secondary btn-sm w-full mt-3"
                onClick={() => navigate(`/report/${jobId}`)}
              >
                📄 View Full Report
              </button>
            </div>
          )}

          {/* Custom options used */}
          {job.custom_options && (
            <div className="card">
              <h4 className="mb-2">Custom ODM Options</h4>
              <pre style={{
                fontSize: 11, fontFamily: 'JetBrains Mono, monospace',
                color: 'var(--text-secondary)', background: 'var(--bg-elevated)',
                borderRadius: 8, padding: '10px 12px', overflow: 'auto',
                maxHeight: 200, margin: 0,
              }}>
                {JSON.stringify(JSON.parse(job.custom_options), null, 2)}
              </pre>
            </div>
          )}

          {/* Quick actions */}
          <div className="card">
            <h4 className="mb-3">Actions</h4>
            <div className="flex-col gap-2">
              {hasEpt && (
                <button className="btn btn-primary btn-sm w-full" onClick={() => navigate(`/viewer/${jobId}`)}>
                  👁 Open 3D Viewer
                </button>
              )}
              <button className="btn btn-secondary btn-sm w-full" onClick={() => navigate(`/report/${jobId}`)}>
                📄 Accuracy Report
              </button>
              <button className="btn btn-secondary btn-sm w-full" onClick={() => navigate(`/projects/${project.id}`)}>
                📋 Project Page
              </button>
              <button className="btn btn-secondary btn-sm w-full" onClick={() => navigate('/projects/new')}>
                ＋ New Project
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
