// Central API client for the PhotoForge backend
import axios from 'axios';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

export const api = axios.create({
  baseURL: API_URL,
  timeout: 30000,
});

// ─── Types ───────────────────────────────────────────────────────────────────

export type ProjectStatus = 'draft' | 'processing' | 'completed' | 'failed';
export type JobStatus =
  | 'queued' | 'sfm' | 'splitting' | 'dense' | 'merging' | 'indexing'
  | 'completed' | 'failed';
export type ProcessingPreset = 'fast_preview' | 'survey_grade' | 'high_fidelity';

export interface Project {
  id: string;
  name: string;
  description?: string;
  status: ProjectStatus;
  coordinate_system?: string;
  image_count: number;
  image_dir?: string;
  output_dir?: string;
  area_acres?: number;
  created_at: string;
  updated_at: string;
  job_count: number;
  gcp_count: number;
  // Phase 3: RTK
  rtk_accuracy_h?: number;
  rtk_accuracy_v?: number;
  rtk_mode?: 'rtk' | 'ppk' | 'none';
  // Phase 4: bbox + area
  bbox?: { min_lat: number; max_lat: number; min_lon: number; max_lon: number };
  area_km2?: number;
}

export interface Job {
  id: string;
  project_id: string;
  status: JobStatus;
  preset: ProcessingPreset;
  progress: number;
  current_step?: string;
  total_images: number;
  split_count: number;
  error_message?: string;
  nodeodm_task_id?: string;
  celery_task_id?: string;
  custom_options?: string;
  started_at?: string;
  completed_at?: string;
  created_at: string;
  // Phase 3: GCP RMSE
  gcp_rmse_x?: number;
  gcp_rmse_y?: number;
  gcp_rmse_z?: number;
  gcp_rmse_total?: number;
}

export interface JobOutput {
  id: number;
  job_id: string;
  output_type: string;
  file_path: string;
  file_size_bytes?: number;
  created_at: string;
}

export interface GCPObservation {
  image: string;
  pixel_x: number;
  pixel_y: number;
}

export interface GCPPoint {
  id?: number;
  label: string;
  x: number;
  y: number;
  z: number;
  observations: GCPObservation[];   // one entry per image
  // Phase 3: accuracy results
  error_x?: number;
  error_y?: number;
  error_z?: number;
  error_total?: number;
}

export interface GCPReport {
  rmse_x?: number;
  rmse_y?: number;
  rmse_z?: number;
  rmse_total?: number;
  gcps: GCPPoint[];
}

export interface SystemStats {
  cpu: { percent: number; cores: number; threads: number };
  memory: { total_gb: number; used_gb: number; percent: number };
  disk: { total_gb: number; used_gb: number; free_gb: number; percent: number };
  gpu: { name?: string; utilization_percent: number; memory_used_mb: number; memory_total_mb: number; temperature_c?: number };
}

export interface ExifSummary {
  total_images: number;
  has_gps_pct: number;
  rtk_fix_pct: number;
  rtk_float_pct?: number;
  camera_makes: string[];
  bbox?: { min_lat: number; max_lat: number; min_lon: number; max_lon: number };
  qualities?: Record<string, number>;
  avg_acc_h?: number;
  avg_acc_v?: number;
}

// ─── API calls ───────────────────────────────────────────────────────────────

export interface AutoDetectResult {
  gcp_label: string;
  image_name: string;
  pixel_x: number;
  pixel_y: number;
  confidence: number;
  strategy: string;
  candidates_scanned: number;
  elapsed_s: number;
  extra: Record<string, unknown>;
}

export type DetectionStrategy =
  | 'triangle_cross'
  | 'spray_paint'
  | 'checkerboard'
  | 'aruco'
  | 'circle_grid'
  | 'template'
  | 'blob';

export interface AutoDetectPayload {
  strategy: DetectionStrategy;
  gcps: Array<{ label: string; x: number; y: number; z: number; lat: number; lon: number }>;
  radius_m?: number;
  max_candidates?: number;
  options?: Record<string, unknown>;
}

export const projectsApi = {
  list: () => api.get<Project[]>('/projects/').then(r => r.data),
  get: (id: string) => api.get<Project>(`/projects/${id}`).then(r => r.data),
  create: (data: FormData) => api.post<Project>('/projects/', data).then(r => r.data),
  delete: (id: string) => api.delete(`/projects/${id}`).then(r => r.data),
  update: (id: string, data: { name?: string; description?: string }) =>
    api.patch<Project>(`/projects/${id}`, data).then(r => r.data),
  duplicate: (id: string) =>
    api.post<Project>(`/projects/${id}/duplicate`).then(r => r.data),
  uploadImages: (id: string, files: FileList) => {
    const fd = new FormData();
    Array.from(files).forEach(f => fd.append('files', f));
    return api.post<{ uploaded: number; total_images: number; exif_summary: ExifSummary }>(
      `/projects/${id}/upload-images`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: 300000,
      }).then(r => r.data);
  },
  saveGCPs: (id: string, gcps: GCPPoint[]) => {
    // Expand each GCP into one flat row per observation (ODM format).
    // GCPs with no observations send one row with no image.
    const flat = gcps.flatMap(g =>
      g.observations && g.observations.length > 0
        ? g.observations.map(obs => ({
            label: g.label, x: g.x, y: g.y, z: g.z,
            image_name: obs.image,
            pixel_x: obs.pixel_x,
            pixel_y: obs.pixel_y,
          }))
        : [{ label: g.label, x: g.x, y: g.y, z: g.z }]
    );
    return api.post(`/projects/${id}/gcps`, flat).then(r => r.data);
  },
  getGCPs: (id: string) =>
    api.get<any[]>(`/projects/${id}/gcps`).then(r => {
      // Backend now returns pre-grouped data: one entry per GCP label
      // with an 'observations' array. Map to GCPPoint shape.
      return r.data.map((row: any): GCPPoint => ({
        id: row.id,
        label: row.label,
        x: row.x,
        y: row.y,
        z: row.z,
        observations: (row.observations ?? []).map((o: any) => ({
          image: o.image,
          pixel_x: o.pixel_x ?? 0,
          pixel_y: o.pixel_y ?? 0,
        })),
        error_x: row.error_x,
        error_y: row.error_y,
        error_z: row.error_z,
        error_total: row.error_total,
      }));
    }),
  updateRtkConfig: (id: string, config: { rtk_accuracy_h?: number; rtk_accuracy_v?: number; rtk_mode?: string }) =>
    api.patch<Project>(`/projects/${id}/rtk-config`, null, { params: config }).then(r => r.data),
  autoDetectGCPs: (id: string, payload: AutoDetectPayload) =>
    api.post<AutoDetectResult[]>(`/projects/${id}/gcps/auto-detect`, payload, { timeout: 300000 }).then(r => r.data),
};

export const jobsApi = {
  start: (projectId: string, preset: ProcessingPreset, customOptions?: string) =>
    api.post<Job>('/jobs/start', null, {
      params: { project_id: projectId, preset, custom_options: customOptions || undefined },
    }).then(r => r.data),
  get: (id: string) => api.get<Job>(`/jobs/${id}`).then(r => r.data),
  listByProject: (projectId: string) =>
    api.get<Job[]>(`/jobs/project/${projectId}`).then(r => r.data),
  getOutputs: (id: string) =>
    api.get<JobOutput[]>(`/jobs/${id}/outputs`).then(r => r.data),
  cancel: (id: string) => api.post(`/jobs/${id}/cancel`).then(r => r.data),
  registerOutputs: (id: string) =>
    api.post<{ registered: string[] }>(`/jobs/${id}/register-outputs`).then(r => r.data),
  parseReport: (id: string) =>
    api.post<{ parsed: boolean; rmse_total?: number }>(`/jobs/${id}/parse-report`).then(r => r.data),
  getGcpReport: (id: string) =>
    api.get<GCPReport>(`/jobs/${id}/gcp-report`).then(r => r.data),
  getQueue: () =>
    api.get<Job[]>('/jobs/queue').then(r => r.data),
  listAll: (limit = 50) =>
    api.get<Job[]>('/jobs/all', { params: { limit } }).then(r => r.data),
  downloadUrl: (jobId: string, outputType: string) =>
    `${API_URL}/jobs/${jobId}/download/${outputType}`,
};

export const systemApi = {
  stats: () => api.get<SystemStats>('/system/stats').then(r => r.data),
  nodeodmStatus: () => api.get<{ online: boolean }>('/system/nodeodm-status').then(r => r.data),
  potreeStatus: () => api.get<{ available: boolean; path: string | null }>('/system/potree-status').then(r => r.data),
};

// ─── WebSocket ────────────────────────────────────────────────────────────────

const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:8000';

export function createJobWebSocket(jobId: string, onMessage: (job: Job) => void): WebSocket {
  const ws = new WebSocket(`${WS_URL}/jobs/ws/${jobId}`);
  ws.onmessage = (e) => {
    try { onMessage(JSON.parse(e.data) as Job); } catch { /* ignore */ }
  };
  return ws;
}
