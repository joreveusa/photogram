/**
 * ReportExport — a print-ready accuracy report for a completed job.
 * Designed for window.print() — print styles hide the nav and show only content.
 *
 * Route: /report/:jobId
 */

import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { jobsApi, projectsApi, type Job, type GCPReport, type Project, type JobOutput } from '../api';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmt(v?: number, unit = 'cm', decimals = 1): string {
  if (v == null) return '—';
  const scaled = unit === 'cm' ? v * 100 : v;
  return `${scaled.toFixed(decimals)} ${unit}`;
}

function rmseColor(v?: number): string {
  if (v == null) return 'inherit';
  if (v < 0.03) return '#22c55e';
  if (v < 0.08) return '#f59e0b';
  return '#ef4444';
}

function rmseLabel(v?: number): string {
  if (v == null) return '—';
  if (v < 0.03) return 'Excellent';
  if (v < 0.08) return 'Acceptable';
  return 'Needs Review';
}

function formatDate(iso?: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function duration(start?: string, end?: string): string {
  if (!start || !end) return '—';
  const ms = new Date(end).getTime() - new Date(start).getTime();
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// ─── Report Page ──────────────────────────────────────────────────────────────

export default function ReportExport() {
  const { jobId } = useParams<{ jobId: string }>();
  const navigate = useNavigate();

  const { data: job, isLoading: loadJob } = useQuery<Job>({
    queryKey: ['job', jobId],
    queryFn: () => jobsApi.get(jobId!),
    enabled: !!jobId,
  });

  const { data: project } = useQuery<Project>({
    queryKey: ['project', job?.project_id],
    queryFn: () => projectsApi.get(job!.project_id),
    enabled: !!job?.project_id,
  });

  const { data: report } = useQuery<GCPReport>({
    queryKey: ['gcp-report', jobId],
    queryFn: () => jobsApi.getGcpReport(jobId!),
    enabled: !!jobId,
    retry: false,
  });

  const { data: outputs = [] } = useQuery<JobOutput[]>({
    queryKey: ['job-outputs', jobId],
    queryFn: () => jobsApi.getOutputs(jobId!),
    enabled: !!jobId,
  });

  if (loadJob) {
    return <div className="page-content"><div className="animate-pulse text-muted">Loading report…</div></div>;
  }

  if (!job || !project) {
    return <div className="page-content"><div className="text-error">Job not found</div></div>;
  }

  const hasGcpData = report?.gcps?.some(g => g.error_total != null);
  const outputMeta: Record<string, string> = {
    orthomosaic: 'Orthomosaic (GeoTIFF)',
    point_cloud: 'Point Cloud (LAZ)',
    mesh: '3D Mesh (OBJ)',
    mesh_glb: '3D Mesh (GLB)',
    dsm: 'Digital Surface Model (GeoTIFF)',
    report: 'Processing Report (PDF)',
    ept: 'Point Cloud (Potree EPT)',
  };

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-primary)' }}>
      {/* Screen-only toolbar */}
      <div className="topbar no-print">
        <div className="flex items-center gap-3">
          <button className="btn btn-ghost btn-sm" onClick={() => navigate(-1)}>← Back</button>
          <span className="topbar-title">Accuracy Report</span>
          <span className="badge badge-completed">
            <span className="badge-dot" /> Completed
          </span>
        </div>
        <div className="flex gap-2">
          <button className="btn btn-secondary" onClick={() => navigate(`/projects/${project.id}`)}>
            View Project
          </button>
          <button className="btn btn-primary" onClick={() => window.print()}>
            🖨 Print / Save PDF
          </button>
        </div>
      </div>

      {/* Report content */}
      <div className="report-page">
        {/* Header */}
        <div className="report-header">
          <div>
            <div className="report-logo">📐 PhotoForge</div>
            <div className="report-subtitle">Photogrammetry Processing Report</div>
          </div>
          <div className="report-meta-box">
            <div>Generated: {formatDate(new Date().toISOString())}</div>
            <div>Job ID: <code>{job.id.slice(0, 8)}…</code></div>
          </div>
        </div>

        <div className="report-divider" />

        {/* Project summary */}
        <section className="report-section">
          <h2 className="report-section-title">Project Summary</h2>
          <div className="report-grid-2">
            <div className="report-kv">
              <span>Project Name</span>
              <strong>{project.name}</strong>
            </div>
            <div className="report-kv">
              <span>Coordinate System</span>
              <strong>{project.coordinate_system ?? '—'}</strong>
            </div>
            <div className="report-kv">
              <span>Processing Preset</span>
              <strong>{job.preset.replace(/_/g, ' ')}</strong>
            </div>
            <div className="report-kv">
              <span>Images Processed</span>
              <strong>{job.total_images.toLocaleString()}</strong>
            </div>
            <div className="report-kv">
              <span>Started</span>
              <strong>{formatDate(job.started_at)}</strong>
            </div>
            <div className="report-kv">
              <span>Processing Time</span>
              <strong>{duration(job.started_at, job.completed_at)}</strong>
            </div>
            {project.rtk_mode && project.rtk_mode !== 'none' && (
              <>
                <div className="report-kv">
                  <span>GPS Mode</span>
                  <strong>{project.rtk_mode.toUpperCase()}</strong>
                </div>
                <div className="report-kv">
                  <span>GPS Accuracy (H/V)</span>
                  <strong>
                    {project.rtk_accuracy_h != null ? `±${(project.rtk_accuracy_h * 100).toFixed(1)} cm` : '—'} /
                    {project.rtk_accuracy_v != null ? ` ±${(project.rtk_accuracy_v * 100).toFixed(1)} cm` : ' —'}
                  </strong>
                </div>
              </>
            )}
            {project.area_km2 != null && (
              <div className="report-kv">
                <span>Coverage Area</span>
                <strong>
                  {project.area_km2.toFixed(4)} km²
                  {' '}({(project.area_km2 * 247.105).toFixed(1)} acres)
                </strong>
              </div>
            )}
          </div>
        </section>

        {/* GCP Accuracy */}
        {hasGcpData && (
          <section className="report-section">
            <h2 className="report-section-title">Ground Control Point Accuracy</h2>

            {/* RMSE summary */}
            {report?.rmse_total != null && (
              <div className="report-rmse-summary">
                {[
                  { label: 'X RMSE', val: report.rmse_x },
                  { label: 'Y RMSE', val: report.rmse_y },
                  { label: 'Z RMSE', val: report.rmse_z },
                  { label: 'Total RMSE', val: report.rmse_total },
                ].map(({ label, val }) => (
                  <div key={label} className="report-rmse-tile">
                    <div className="report-rmse-label">{label}</div>
                    <div className="report-rmse-value" style={{ color: rmseColor(val) }}>
                      {fmt(val)}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {report?.rmse_total != null && (
              <div className="report-verdict" style={{
                borderLeft: `4px solid ${rmseColor(report.rmse_total)}`,
                color: rmseColor(report.rmse_total),
              }}>
                Overall accuracy: <strong>{rmseLabel(report.rmse_total)}</strong>
                {report.rmse_total < 0.03 && ' — Meets survey-grade requirements'}
                {report.rmse_total >= 0.03 && report.rmse_total < 0.08 && ' — Acceptable for mapping purposes'}
                {report.rmse_total >= 0.08 && ' — Consider adding more GCPs or reviewing image overlap'}
              </div>
            )}

            {/* Per-GCP table */}
            <table className="report-table">
              <thead>
                <tr>
                  <th>GCP Label</th>
                  <th>X (Easting)</th>
                  <th>Y (Northing)</th>
                  <th>Z (Elevation)</th>
                  <th>Err X</th>
                  <th>Err Y</th>
                  <th>Err Z</th>
                  <th>Total</th>
                  <th>Rating</th>
                </tr>
              </thead>
              <tbody>
                {report!.gcps.filter(g => g.error_total != null).map(g => (
                  <tr key={g.label}>
                    <td><strong>{g.label}</strong></td>
                    <td className="mono">{g.x.toFixed(3)}</td>
                    <td className="mono">{g.y.toFixed(3)}</td>
                    <td className="mono">{g.z.toFixed(3)}</td>
                    <td style={{ color: rmseColor(g.error_x) }}>{fmt(g.error_x)}</td>
                    <td style={{ color: rmseColor(g.error_y) }}>{fmt(g.error_y)}</td>
                    <td style={{ color: rmseColor(g.error_z) }}>{fmt(g.error_z)}</td>
                    <td style={{ color: rmseColor(g.error_total), fontWeight: 700 }}>{fmt(g.error_total)}</td>
                    <td style={{ color: rmseColor(g.error_total) }}>{rmseLabel(g.error_total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {/* Deliverables */}
        <section className="report-section">
          <h2 className="report-section-title">Deliverables</h2>
          <table className="report-table">
            <thead>
              <tr>
                <th>Output Type</th>
                <th>File Size</th>
                <th>Available</th>
              </tr>
            </thead>
            <tbody>
              {outputs.map(o => (
                <tr key={o.id}>
                  <td>{outputMeta[o.output_type] ?? o.output_type}</td>
                  <td className="mono">
                    {o.file_size_bytes
                      ? o.file_size_bytes > 1e9
                        ? `${(o.file_size_bytes / 1e9).toFixed(2)} GB`
                        : `${(o.file_size_bytes / 1e6).toFixed(1)} MB`
                      : '—'}
                  </td>
                  <td style={{ color: '#22c55e' }}>✓ Yes</td>
                </tr>
              ))}
              {outputs.length === 0 && (
                <tr><td colSpan={3} style={{ color: '#64748b' }}>No outputs recorded</td></tr>
              )}
            </tbody>
          </table>
        </section>

        {/* Footer */}
        <div className="report-footer">
          Generated by PhotoForge · Local photogrammetry processing · {new Date().getFullYear()}
        </div>
      </div>
    </div>
  );
}
