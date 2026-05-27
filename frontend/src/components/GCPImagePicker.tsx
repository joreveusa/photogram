import { useState, useMemo, MouseEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import proj4 from 'proj4';
import { api, projectsApi } from '../api';

interface ImageInfo {
  filename: string;
  size_bytes?: number;
  latitude?: number | null;
  longitude?: number | null;
  altitude?: number | null;
}

interface GCPImagePickerProps {
  projectId: string;
  gcpX?: number;
  gcpY?: number;
  gcpLabel?: string;
  onSelect: (imageName: string, pixelX: number, pixelY: number) => void;
  onClose: () => void;
}

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

function thumbUrl(projectId: string, filename: string) {
  return `${API_URL}/projects/${projectId}/thumbnail/${encodeURIComponent(filename)}`;
}

// Define projections from the UI options
proj4.defs([
  ['EPSG:6529', '+proj=tmerc +lat_0=31 +lon_0=-106.25 +k=0.9999 +x_0=500000.00001016 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=us-ft +no_defs'],
  ['EPSG:6528', '+proj=tmerc +lat_0=31 +lon_0=-104.333333333333 +k=0.9999 +x_0=165000.000003353 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=us-ft +no_defs'],
  ['EPSG:6530', '+proj=tmerc +lat_0=31 +lon_0=-108.333333333333 +k=0.9999 +x_0=830000.000016933 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=us-ft +no_defs'],
  ['EPSG:32654', '+proj=utm +zone=54 +datum=WGS84 +units=m +no_defs'],
  ['EPSG:32610', '+proj=utm +zone=10 +datum=WGS84 +units=m +no_defs'],
  ['EPSG:27700', '+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +datum=OSGB36 +units=m +no_defs'],
  ['EPSG:3857', '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs']
]);

/** 2D Euclidean distance */
function dist2D(x1: number, y1: number, x2: number, y2: number): number {
  return Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
}

function formatDist(m: number): string {
  if (m < 1) return `${(m * 100).toFixed(0)} units`;
  if (m < 1000) return `${m.toFixed(0)} units`;
  return `${(m / 1000).toFixed(1)}k units`;
}

function distColor(m: number): string {
  if (m < 30) return 'var(--success)';
  if (m < 80) return 'var(--accent)';
  if (m < 200) return 'var(--warning)';
  return 'var(--text-muted)';
}

export default function GCPImagePicker({
  projectId,
  gcpX,
  gcpY,
  gcpLabel,
  onSelect,
  onClose,
}: GCPImagePickerProps) {
  const [selectedImage, setSelectedImage] = useState<ImageInfo | null>(null);
  const [filter, setFilter] = useState<'nearest' | 'all'>('nearest');

  const { data: project } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => projectsApi.get(projectId),
  });

  const { data: images = [], isLoading, error } = useQuery<ImageInfo[]>({
    queryKey: ['project-images', projectId],
    queryFn: () => api.get<ImageInfo[]>(`/projects/${projectId}/images`).then((r) => r.data),
  });

  // Whether the project CRS is geographic (lat/lon). WGS84 or any EPSG:4326-like.
  const crs = project?.coordinate_system || 'EPSG:4326';

  // Sort images by distance to GCP using the project's coordinate system
  const sortedImages = useMemo(() => {
    if (gcpX == null || gcpY == null) return images;

    const isWgs84 = crs === 'EPSG:4326';

    const withDist = images.map((img) => {
      let dist: number | null = null;
      if (img.latitude != null && img.longitude != null) {
        if (isWgs84) {
          // WGS84: gcpX = Longitude, gcpY = Latitude
          // Convert degree difference to approximate metres for meaningful distance sorting
          const mPerDegLat = 111320;
          const mPerDegLon = 111320 * Math.cos((gcpY * Math.PI) / 180);
          const dx = (img.longitude - gcpX) * mPerDegLon;
          const dy = (img.latitude - gcpY) * mPerDegLat;
          dist = Math.sqrt(dx * dx + dy * dy);
        } else {
          // Project CRS (e.g. NM State Plane): project image Lat/Lon into that CRS
          try {
            const [projX, projY] = proj4('EPSG:4326', crs, [img.longitude, img.latitude]);
            dist = dist2D(gcpX, gcpY, projX, projY);
          } catch {
            // Unknown projection — leave dist null
          }
        }
      }
      return { ...img, dist };
    });

    // Nearest first; images without GPS go to the bottom
    withDist.sort((a, b) => {
      if (a.dist == null && b.dist == null) return 0;
      if (a.dist == null) return 1;
      if (b.dist == null) return -1;
      return a.dist - b.dist;
    });

    return withDist;
  }, [images, gcpX, gcpY, crs]);

  const displayImages = useMemo(() => {
    // When we have distance data and the user chose 'nearest', cap at 30
    if (filter === 'nearest' && gcpX != null && gcpY != null) {
      return sortedImages.slice(0, 30);
    }
    return sortedImages;
  }, [sortedImages, filter, gcpX, gcpY]);

  const handleImageClick = (e: MouseEvent<HTMLImageElement>) => {
    if (!selectedImage) return;
    const img = e.currentTarget;
    const rect = img.getBoundingClientRect();
    const scaleX = img.naturalWidth / rect.width;
    const scaleY = img.naturalHeight / rect.height;
    const x = Math.round((e.clientX - rect.left) * scaleX);
    const y = Math.round((e.clientY - rect.top) * scaleY);
    onSelect(selectedImage.filename, x, y);
  };

  return (
    <div
      className="modal-overlay"
      style={{ zIndex: 9999, padding: 24 }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="card"
        style={{
          width: '100%',
          maxWidth: 1100,
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 style={{ fontSize: 20, marginBottom: 4 }}>
              {selectedImage ? '📍 Click on the GCP Target' : '📷 Select Photo for GCP'}
            </h2>
            {gcpLabel && (
              <span
                style={{
                  fontSize: 12,
                  padding: '2px 10px',
                  borderRadius: 99,
                  background: 'var(--accent-subtle)',
                  color: 'var(--accent)',
                  fontWeight: 600,
                }}
              >
                {gcpLabel}
              </span>
            )}
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>
            ✕ Close
          </button>
        </div>

        {selectedImage ? (
          /* ── Full image view for pixel picking ─────────────────────────── */
          <div
            style={{
              flex: 1,
              overflow: 'auto',
              textAlign: 'center',
              background: 'var(--bg-elevated)',
              borderRadius: 8,
            }}
          >
            <div
              style={{
                padding: '10px 16px',
                position: 'sticky',
                top: 0,
                background: 'rgba(0,0,0,0.7)',
                backdropFilter: 'blur(8px)',
                color: '#fff',
                zIndex: 10,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                fontSize: 13,
              }}
            >
              <span>
                Click exactly on the GCP center ·{' '}
                <span style={{ color: 'var(--accent)' }}>{selectedImage.filename}</span>
              </span>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => setSelectedImage(null)}
              >
                ← Back to Gallery
              </button>
            </div>
            <img
              src={thumbUrl(projectId, selectedImage.filename)}
              alt={selectedImage.filename}
              onClick={handleImageClick}
              style={{ cursor: 'crosshair', maxWidth: '100%', objectFit: 'contain' }}
            />
          </div>
        ) : (
          /* ── Gallery with proximity sorting ────────────────────────────── */
          <>
            {/* Filter bar */}
            {gcpX != null && gcpY != null && (
              <div
                className="flex items-center justify-between mb-3"
                style={{
                  padding: '8px 12px',
                  background: 'var(--bg-elevated)',
                  borderRadius: 8,
                  fontSize: 12,
                }}
              >
                <span style={{ color: 'var(--text-secondary)' }}>
                  📍 Sorted by distance to GCP{' '}
                  <span style={{ color: 'var(--accent)', fontWeight: 600 }}>
                    ({gcpY!.toFixed(5)}, {gcpX!.toFixed(5)})
                  </span>
                </span>
                <div className="flex gap-2">
                  <button
                    className={`btn btn-sm ${filter === 'nearest' ? 'btn-primary' : 'btn-secondary'}`}
                    onClick={() => setFilter('nearest')}
                  >
                    Nearest 30
                  </button>
                  <button
                    className={`btn btn-sm ${filter === 'all' ? 'btn-primary' : 'btn-secondary'}`}
                    onClick={() => setFilter('all')}
                  >
                    All ({images.length})
                  </button>
                </div>
              </div>
            )}

            <div style={{ flex: 1, overflow: 'auto' }}>
              {isLoading ? (
                <div className="text-muted" style={{ padding: 24, textAlign: 'center' }}>
                  Loading images…
                </div>
              ) : error ? (
                <div className="text-error" style={{ padding: 24, textAlign: 'center' }}>
                  Failed to load images.
                </div>
              ) : images.length === 0 ? (
                <div className="text-muted" style={{ padding: 24, textAlign: 'center' }}>
                  No images found. Upload images in the Images step first.
                </div>
              ) : (
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
                    gap: 12,
                  }}
                >
                  {displayImages.map((img: any) => (
                    <div
                      key={img.filename}
                      onClick={() => setSelectedImage(img)}
                      style={{
                        cursor: 'pointer',
                        borderRadius: 8,
                        overflow: 'hidden',
                        background: 'var(--bg-elevated)',
                        border: '1px solid var(--border)',
                        transition: 'border-color 150ms, transform 150ms',
                        position: 'relative',
                      }}
                      onMouseEnter={(e) => {
                        (e.currentTarget as HTMLElement).style.borderColor = 'var(--accent)';
                        (e.currentTarget as HTMLElement).style.transform = 'scale(1.02)';
                      }}
                      onMouseLeave={(e) => {
                        (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)';
                        (e.currentTarget as HTMLElement).style.transform = '';
                      }}
                    >
                      <img
                        src={thumbUrl(projectId, img.filename)}
                        alt={img.filename}
                        style={{
                          width: '100%',
                          aspectRatio: '4/3',
                          objectFit: 'cover',
                        }}
                        loading="lazy"
                      />
                      {/* Distance badge */}
                      {img.dist != null && (
                        <div
                          style={{
                            position: 'absolute',
                            top: 6,
                            right: 6,
                            padding: '2px 8px',
                            borderRadius: 99,
                            fontSize: 10,
                            fontWeight: 700,
                            background: 'rgba(0,0,0,0.7)',
                            backdropFilter: 'blur(4px)',
                            color: distColor(img.dist),
                            border: `1px solid ${distColor(img.dist)}`,
                          }}
                        >
                          {formatDist(img.dist)}
                        </div>
                      )}
                      {/* No GPS indicator */}
                      {img.latitude == null && (
                        <div
                          style={{
                            position: 'absolute',
                            top: 6,
                            right: 6,
                            padding: '2px 8px',
                            borderRadius: 99,
                            fontSize: 10,
                            fontWeight: 600,
                            background: 'rgba(0,0,0,0.7)',
                            color: 'var(--text-muted)',
                          }}
                        >
                          No GPS
                        </div>
                      )}
                      <div
                        style={{
                          padding: '6px 8px',
                          fontSize: 11,
                          textAlign: 'center',
                          textOverflow: 'ellipsis',
                          overflow: 'hidden',
                          whiteSpace: 'nowrap',
                          color: 'var(--text-secondary)',
                        }}
                      >
                        {img.filename}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
