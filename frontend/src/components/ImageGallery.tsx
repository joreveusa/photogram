/**
 * ImageGallery — shows uploaded images for a project as a grid of thumbnails.
 * Fetches from GET /projects/{id}/images (returns list of filenames).
 * Falls back gracefully if the endpoint isn't available yet.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';

interface Props { projectId: string; imageCount: number; }

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

interface ImageInfo { filename: string; size_bytes?: number; }

function thumbUrl(projectId: string, filename: string) {
  return `${API_URL}/projects/${projectId}/thumbnail/${encodeURIComponent(filename)}`;
}

// ─── Lightbox ─────────────────────────────────────────────────────────────────

function Lightbox({ src, name, onClose }: { src: string; name: string; onClose: () => void }) {
  return (
    <div
      className="modal-overlay"
      onClick={onClose}
      style={{ flexDirection: 'column', gap: 16 }}
    >
      <div className="flex items-center gap-3 no-print" style={{ zIndex: 1001 }}>
        <span className="text-xs text-muted">{name}</span>
        <button className="btn btn-ghost btn-sm" onClick={onClose}>✕ Close</button>
      </div>
      <img
        src={src}
        alt={name}
        onClick={e => e.stopPropagation()}
        style={{
          maxWidth: '90vw', maxHeight: '80vh',
          borderRadius: 12, boxShadow: '0 24px 64px rgba(0,0,0,0.8)',
          objectFit: 'contain',
        }}
      />
    </div>
  );
}

// ─── Thumbnail ────────────────────────────────────────────────────────────────

function Thumbnail({ projectId, image, onClick }: {
  projectId: string; image: ImageInfo; onClick: () => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);

  return (
    <div
      onClick={onClick}
      style={{
        aspectRatio: '4/3', borderRadius: 8, overflow: 'hidden',
        background: 'var(--bg-elevated)', cursor: 'pointer',
        border: '1px solid var(--border)',
        transition: 'transform 150ms ease, border-color 150ms ease',
        position: 'relative',
      }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.transform = 'scale(1.02)'; (e.currentTarget as HTMLElement).style.borderColor = 'var(--border-accent)'; }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.transform = ''; (e.currentTarget as HTMLElement).style.borderColor = ''; }}
    >
      {!errored ? (
        <img
          src={thumbUrl(projectId, image.filename)}
          alt={image.filename}
          onLoad={() => setLoaded(true)}
          onError={() => setErrored(true)}
          style={{
            width: '100%', height: '100%', objectFit: 'cover',
            opacity: loaded ? 1 : 0,
            transition: 'opacity 300ms ease',
          }}
        />
      ) : (
        <div style={{
          width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 4,
        }}>
          <span style={{ fontSize: 24 }}>🖼</span>
          <span className="text-xs text-muted" style={{ textAlign: 'center', padding: '0 4px' }}>
            {image.filename.slice(-20)}
          </span>
        </div>
      )}
      {!loaded && !errored && (
        <div className="skeleton" style={{ position: 'absolute', inset: 0 }} />
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function ImageGallery({ projectId, imageCount }: Props) {
  const [lightbox, setLightbox] = useState<ImageInfo | null>(null);
  const [page, setPage] = useState(0);
  const PER_PAGE = 24;

  const { data: images = [], isLoading, error } = useQuery<ImageInfo[]>({
    queryKey: ['project-images', projectId],
    queryFn: () => api.get<ImageInfo[]>(`/projects/${projectId}/images`).then(r => r.data),
    enabled: imageCount > 0,
    retry: false,
  });

  if (imageCount === 0) return null;

  // Backend endpoint may not exist yet — show a placeholder
  if (error) {
    return (
      <div className="card">
        <h3 className="mb-2">Images</h3>
        <p className="text-sm text-muted">
          {imageCount.toLocaleString()} images uploaded.
          Thumbnail preview requires <code>GET /projects/{'{id}'}/images</code> endpoint.
        </p>
      </div>
    );
  }

  const totalPages = Math.ceil(images.length / PER_PAGE);
  const pageImages = images.slice(page * PER_PAGE, (page + 1) * PER_PAGE);

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3>Images</h3>
          <div className="text-xs text-muted mt-1">
            {isLoading ? 'Loading…' : `${images.length.toLocaleString()} files`}
          </div>
        </div>
        {totalPages > 1 && (
          <div className="flex items-center gap-2">
            <button className="btn btn-ghost btn-sm" disabled={page === 0} onClick={() => setPage(p => p - 1)}>‹</button>
            <span className="text-xs text-muted">{page + 1} / {totalPages}</span>
            <button className="btn btn-ghost btn-sm" disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}>›</button>
          </div>
        )}
      </div>

      {isLoading ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px,1fr))', gap: 8 }}>
          {Array.from({ length: Math.min(imageCount, 12) }).map((_, i) => (
            <div key={i} className="skeleton" style={{ aspectRatio: '4/3', borderRadius: 8 }} />
          ))}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px,1fr))', gap: 8 }}>
          {pageImages.map(img => (
            <Thumbnail
              key={img.filename}
              projectId={projectId} image={img}
              onClick={() => setLightbox(img)}
            />
          ))}
        </div>
      )}

      {lightbox && (
        <Lightbox
          src={thumbUrl(projectId, lightbox.filename)}
          name={lightbox.filename}
          onClose={() => setLightbox(null)}
        />
      )}
    </div>
  );
}
