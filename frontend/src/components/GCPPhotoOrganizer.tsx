/**
 * GCPPhotoOrganizer — shows every GCP as a row with its nearest photos
 * ranked by GPS distance. Click a thumbnail to enter pixel-picking mode
 * for that GCP. Replaces the need to blindly scroll through all images.
 */

import React, { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import proj4 from 'proj4';
import { api, projectsApi, type GCPPoint } from '../api';

// ─── Shared projection definitions ───────────────────────────────────────────
proj4.defs([
  ['EPSG:6529', '+proj=tmerc +lat_0=31 +lon_0=-106.25 +k=0.9999 +x_0=500000.00001016 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=us-ft +no_defs'],
  ['EPSG:6528', '+proj=tmerc +lat_0=31 +lon_0=-104.333333333333 +k=0.9999 +x_0=165000.000003353 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=us-ft +no_defs'],
  ['EPSG:6530', '+proj=tmerc +lat_0=31 +lon_0=-108.333333333333 +k=0.9999 +x_0=830000.000016933 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=us-ft +no_defs'],
  ['EPSG:32654', '+proj=utm +zone=54 +datum=WGS84 +units=m +no_defs'],
  ['EPSG:32610', '+proj=utm +zone=10 +datum=WGS84 +units=m +no_defs'],
  ['EPSG:27700', '+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +datum=OSGB36 +units=m +no_defs'],
  ['EPSG:3857', '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs'],
]);

// ─── Types ────────────────────────────────────────────────────────────────────

interface ImageInfo {
  filename: string;
  latitude?: number | null;
  longitude?: number | null;
  altitude?: number | null;
}

interface RankedImage extends ImageInfo {
  distM: number | null; // distance in metres (or feet for projected CRS)
}

interface PickingTarget {
  gcp: GCPPoint;
  image: RankedImage;
}

interface Props {
  projectId: string;
  gcps: GCPPoint[];
  /** Called when user clicks a pixel on the chosen image */
  onAssign: (gcpLabel: string, imageName: string, pixelX: number, pixelY: number) => void;
  onClose: () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

function thumbUrl(projectId: string, filename: string) {
  return `${API_URL}/projects/${projectId}/thumbnail/${encodeURIComponent(filename)}`;
}

function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000;
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function dist2D(x1: number, y1: number, x2: number, y2: number) {
  return Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
}

/** Human-readable distance string */
function fmtDist(m: number, isProjected: boolean): string {
  if (isProjected) {
    // US-ft projected CRS — show in feet
    if (m < 10) return `${m.toFixed(1)} ft`;
    if (m < 5280) return `${m.toFixed(0)} ft`;
    return `${(m / 5280).toFixed(2)} mi`;
  }
  // Metric
  if (m < 1) return `${(m * 100).toFixed(0)} cm`;
  if (m < 1000) return `${m.toFixed(0)} m`;
  return `${(m / 1000).toFixed(2)} km`;
}

/** Traffic-light colour based on how close a photo is */
function distColor(m: number | null): string {
  if (m == null) return 'var(--text-muted)';
  if (m < 30) return '#22c55e';   // green  — very close, almost certainly contains GCP
  if (m < 80) return '#f59e0b';   // amber  — probably overlaps
  if (m < 200) return '#ef4444';  // red    — marginal
  return 'var(--text-muted)';     // grey   — unlikely to show GCP
}

/** Convert GCP (X,Y) to WGS84 lat/lon for Haversine, given the project CRS */
function gcpToLatLon(gcpX: number, gcpY: number, crs: string): [number, number] | null {
  try {
    if (crs === 'EPSG:4326') {
      // gcpX = longitude, gcpY = latitude
      return [gcpY, gcpX];
    }
    const [lon, lat] = proj4(crs, 'EPSG:4326', [gcpX, gcpY]);
    return [lat, lon];
  } catch {
    return null;
  }
}

// ─── Sub-components ───────────────────────────────────────────────────────────

/** Single thumbnail card within the organizer grid */
function PhotoCard({
  img,
  projectId,
  assigned,
  isProjected,
  onClick,
}: {
  img: RankedImage;
  projectId: string;
  assigned: boolean;
  isProjected: boolean;
  onClick: () => void;
}) {
  const color = distColor(img.distM);
  const [hover, setHover] = useState(false);

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={`${img.filename}\n${img.distM != null ? fmtDist(img.distM, isProjected) : 'No GPS'}`}
      style={{
        position: 'relative',
        width: 120,
        flexShrink: 0,
        borderRadius: 8,
        overflow: 'hidden',
        cursor: 'pointer',
        border: assigned
          ? '2px solid var(--accent)'
          : hover
          ? `2px solid ${color}`
          : '2px solid var(--border)',
        transition: 'border-color 150ms, transform 150ms, box-shadow 150ms',
        transform: hover ? 'scale(1.04)' : 'scale(1)',
        boxShadow: hover ? '0 4px 16px rgba(0,0,0,0.4)' : 'none',
        background: 'var(--bg-elevated)',
      }}
    >
      {/* Thumbnail */}
      <img
        src={thumbUrl(projectId, img.filename)}
        alt={img.filename}
        loading="lazy"
        style={{ width: '100%', aspectRatio: '4/3', objectFit: 'cover', display: 'block' }}
      />

      {/* Distance badge — top-right */}
      <div
        style={{
          position: 'absolute',
          top: 5,
          right: 5,
          padding: '2px 7px',
          borderRadius: 99,
          fontSize: 10,
          fontWeight: 700,
          background: 'rgba(0,0,0,0.75)',
          backdropFilter: 'blur(4px)',
          color: color,
          border: `1px solid ${color}`,
          whiteSpace: 'nowrap',
        }}
      >
        {img.distM != null ? fmtDist(img.distM, isProjected) : 'No GPS'}
      </div>

      {/* Assigned checkmark */}
      {assigned && (
        <div
          style={{
            position: 'absolute',
            top: 5,
            left: 5,
            width: 20,
            height: 20,
            borderRadius: '50%',
            background: 'var(--accent)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 11,
            color: '#fff',
            fontWeight: 700,
          }}
        >
          ✓
        </div>
      )}

      {/* Filename label */}
      <div
        style={{
          padding: '4px 6px',
          fontSize: 9,
          color: 'var(--text-muted)',
          textOverflow: 'ellipsis',
          overflow: 'hidden',
          whiteSpace: 'nowrap',
          textAlign: 'center',
          background: 'rgba(0,0,0,0.5)',
        }}
      >
        {img.filename}
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function GCPPhotoOrganizer({ projectId, gcps, onAssign, onClose }: Props) {
  const [pickingTarget, setPickingTarget] = useState<PickingTarget | null>(null);
  const [maxPhotos, setMaxPhotos] = useState(8);
  const [showAll, setShowAll] = useState(false);

  const { data: project } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => projectsApi.get(projectId),
  });

  const { data: images = [], isLoading } = useQuery<ImageInfo[]>({
    queryKey: ['project-images', projectId],
    queryFn: () => api.get<ImageInfo[]>(`/projects/${projectId}/images`).then((r) => r.data),
  });

  const crs = project?.coordinate_system || 'EPSG:4326';
  const isProjected = crs !== 'EPSG:4326';

  // For each GCP, compute ranked image list
  const gcpRows = useMemo(() => {
    return gcps.map((gcp) => {
      const gcpLatLon = gcpToLatLon(gcp.x, gcp.y, crs);

      const ranked: RankedImage[] = images.map((img) => {
        let distM: number | null = null;

        if (img.latitude != null && img.longitude != null) {
          if (gcpLatLon) {
            // Haversine for WGS84 CRS, projected CRS converted to lat/lon first
            distM = haversineM(gcpLatLon[0], gcpLatLon[1], img.latitude, img.longitude);
          } else if (!isProjected) {
            // Fallback: approximate metres from degrees
            const mPerDegLat = 111320;
            const mPerDegLon = 111320 * Math.cos((gcp.y * Math.PI) / 180);
            distM = Math.sqrt(
              ((img.longitude - gcp.x) * mPerDegLon) ** 2 +
              ((img.latitude - gcp.y) * mPerDegLat) ** 2
            );
          } else {
            // Projected CRS: project image coords and use 2D distance (in CRS units)
            try {
              const [px, py] = proj4('EPSG:4326', crs, [img.longitude, img.latitude]);
              distM = dist2D(gcp.x, gcp.y, px, py);
            } catch { /* ignore */ }
          }
        }
        return { ...img, distM };
      });

      // Sort nearest first, no-GPS at end
      ranked.sort((a, b) => {
        if (a.distM == null && b.distM == null) return 0;
        if (a.distM == null) return 1;
        if (b.distM == null) return -1;
        return a.distM - b.distM;
      });

      const hasGps = ranked.filter((r) => r.distM != null).length;
      const nearest = ranked[0]?.distM ?? null;

      return { gcp, ranked, hasGps, nearest };
    });
  }, [gcps, images, crs, isProjected]);

  const handleImageClick = (e: React.MouseEvent<HTMLImageElement>) => {
    if (!pickingTarget) return;
    const img = e.currentTarget;
    const rect = img.getBoundingClientRect();
    const scaleX = img.naturalWidth / rect.width;
    const scaleY = img.naturalHeight / rect.height;
    const x = Math.round((e.clientX - rect.left) * scaleX);
    const y = Math.round((e.clientY - rect.top) * scaleY);
    onAssign(pickingTarget.gcp.label, pickingTarget.image.filename, x, y);
    setPickingTarget(null);
  };

  // ── Pixel-picking view ────────────────────────────────────────────────────
  if (pickingTarget) {
    const { gcp, image } = pickingTarget;
    return (
      <div
        className="modal-overlay"
        style={{ zIndex: 9999, padding: 24 }}
        onClick={(e) => { if (e.target === e.currentTarget) setPickingTarget(null); }}
      >
        <div
          className="card"
          style={{ width: '100%', maxWidth: 1100, maxHeight: '92vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
        >
          {/* Header */}
          <div
            style={{
              padding: '10px 16px',
              background: 'rgba(0,0,0,0.6)',
              backdropFilter: 'blur(8px)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              borderBottom: '1px solid var(--border)',
              marginBottom: 0,
              flexShrink: 0,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ fontSize: 18 }}>📍</span>
              <div>
                <div style={{ fontWeight: 700, fontSize: 14 }}>
                  Click the GCP target in this photo
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                  GCP <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{gcp.label}</span>
                  {' '}·{' '}
                  <span style={{ color: 'var(--text-secondary)' }}>{image.filename}</span>
                  {image.distM != null && (
                    <span style={{ marginLeft: 8, color: distColor(image.distM) }}>
                      {fmtDist(image.distM, isProjected)} from GCP
                    </span>
                  )}
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-secondary btn-sm" onClick={() => setPickingTarget(null)}>
                ← Back
              </button>
              <button className="btn btn-ghost btn-sm" onClick={onClose}>
                ✕ Close
              </button>
            </div>
          </div>

          {/* Full-size image for clicking */}
          <div style={{ flex: 1, overflow: 'auto', background: '#0a0a0a', textAlign: 'center' }}>
            <img
              src={thumbUrl(projectId, image.filename)}
              alt={image.filename}
              onClick={handleImageClick}
              style={{ cursor: 'crosshair', maxWidth: '100%', objectFit: 'contain' }}
            />
          </div>
        </div>
      </div>
    );
  }

  // ── Main organizer view ───────────────────────────────────────────────────
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
          maxWidth: 1280,
          maxHeight: '92vh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between mb-4" style={{ flexShrink: 0 }}>
          <div>
            <h2 style={{ fontSize: 20, marginBottom: 4 }}>📸 Photo–GCP Organizer</h2>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>
              Photos ranked by GPS distance to each GCP · Click any thumbnail to mark the GCP center
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {/* CRS info pill */}
            <span
              style={{
                fontSize: 11,
                padding: '3px 10px',
                borderRadius: 99,
                background: 'var(--bg-elevated)',
                color: 'var(--text-secondary)',
                border: '1px solid var(--border)',
              }}
            >
              {crs}
            </span>
            {/* Photos per row control */}
            <select
              className="input"
              style={{ padding: '4px 8px', fontSize: 12, width: 'auto' }}
              value={maxPhotos}
              onChange={(e) => setMaxPhotos(Number(e.target.value))}
            >
              {[5, 8, 12, 20].map((n) => (
                <option key={n} value={n}>
                  Show {n} photos / GCP
                </option>
              ))}
            </select>
            <button className="btn btn-ghost btn-sm" onClick={onClose}>
              ✕ Close
            </button>
          </div>
        </div>

        {/* ── Legend ─────────────────────────────────────────────────────── */}
        <div
          style={{
            display: 'flex',
            gap: 16,
            padding: '8px 12px',
            borderRadius: 8,
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            fontSize: 11,
            color: 'var(--text-secondary)',
            marginBottom: 16,
            flexShrink: 0,
            flexWrap: 'wrap',
          }}
        >
          <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>Distance legend:</span>
          {[
            { color: '#22c55e', label: '< 30 m — Close (GCP likely visible)' },
            { color: '#f59e0b', label: '30–80 m — Near (may overlap)' },
            { color: '#ef4444', label: '80–200 m — Far (check carefully)' },
            { color: 'var(--text-muted)', label: '> 200 m / No GPS' },
          ].map(({ color, label }) => (
            <span key={label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: color, display: 'inline-block' }} />
              {label}
            </span>
          ))}
        </div>

        {/* ── GCP rows ───────────────────────────────────────────────────── */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {isLoading ? (
            <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)' }}>
              Loading photos…
            </div>
          ) : images.length === 0 ? (
            <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)' }}>
              No images uploaded yet. Upload photos in the Images step first.
            </div>
          ) : gcps.length === 0 ? (
            <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)' }}>
              No GCPs defined. Add GCPs first, then come back here.
            </div>
          ) : (
            gcpRows.map(({ gcp, ranked, hasGps, nearest }) => {
              const display = showAll ? ranked : ranked.slice(0, maxPhotos);
              const assignedImg = gcp.observations[0]?.image;
              return (
                <div
                  key={gcp.label}
                  style={{
                    marginBottom: 24,
                    borderRadius: 10,
                    border: '1px solid var(--border)',
                    overflow: 'hidden',
                    background: 'var(--bg-card)',
                  }}
                >
                  {/* Row header */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      padding: '10px 14px',
                      background: 'var(--bg-elevated)',
                      borderBottom: '1px solid var(--border)',
                    }}
                  >
                    {/* GCP label pill */}
                    <div
                      style={{
                        padding: '3px 12px',
                        borderRadius: 99,
                        background: 'var(--accent-subtle)',
                        color: 'var(--accent)',
                        fontWeight: 700,
                        fontSize: 13,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {gcp.label}
                    </div>

                    {/* Coordinates */}
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace' }}>
                      X {gcp.x.toFixed(4)} · Y {gcp.y.toFixed(4)} · Z {gcp.z.toFixed(3)}
                    </div>

                    {/* Stats */}
                    <div style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center' }}>
                      {hasGps > 0 ? (
                        <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                          {hasGps} photos with GPS
                          {nearest != null && (
                            <span style={{ marginLeft: 6, color: distColor(nearest), fontWeight: 600 }}>
                              · nearest {fmtDist(nearest, isProjected)}
                            </span>
                          )}
                        </span>
                      ) : (
                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                          No GPS-tagged photos found
                        </span>
                      )}

                      {/* Already-assigned badge */}
                      {assignedImg ? (
                        <span
                          style={{
                            fontSize: 10,
                            padding: '2px 8px',
                            borderRadius: 99,
                            background: 'rgba(34,197,94,0.15)',
                            color: '#22c55e',
                            border: '1px solid #22c55e',
                            fontWeight: 600,
                          }}
                        >
                          ✓ Assigned: {assignedImg}
                        </span>
                      ) : (
                        <span
                          style={{
                            fontSize: 10,
                            padding: '2px 8px',
                            borderRadius: 99,
                            background: 'rgba(239,68,68,0.1)',
                            color: 'var(--error)',
                            border: '1px solid var(--error)',
                            fontWeight: 600,
                          }}
                        >
                          ● Not assigned
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Photo strip */}
                  <div
                    style={{
                      display: 'flex',
                      gap: 10,
                      padding: '12px 14px',
                      overflowX: 'auto',
                      alignItems: 'flex-start',
                    }}
                  >
                    {display.length === 0 ? (
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '20px 0' }}>
                        No photos available.
                      </div>
                    ) : (
                      <>
                        {display.map((img) => (
                          <PhotoCard
                            key={img.filename}
                            img={img}
                            projectId={projectId}
                            assigned={img.filename === assignedImg}
                            isProjected={isProjected}
                            onClick={() => setPickingTarget({ gcp, image: img })}
                          />
                        ))}

                        {/* "Show more" card */}
                        {!showAll && ranked.length > maxPhotos && (
                          <div
                            onClick={() => setShowAll(true)}
                            style={{
                              width: 120,
                              flexShrink: 0,
                              aspectRatio: '4/3',
                              borderRadius: 8,
                              border: '2px dashed var(--border)',
                              display: 'flex',
                              flexDirection: 'column',
                              alignItems: 'center',
                              justifyContent: 'center',
                              cursor: 'pointer',
                              color: 'var(--text-muted)',
                              fontSize: 12,
                              gap: 4,
                              transition: 'border-color 150ms, color 150ms',
                            }}
                            onMouseEnter={(e) => {
                              (e.currentTarget as HTMLElement).style.borderColor = 'var(--accent)';
                              (e.currentTarget as HTMLElement).style.color = 'var(--accent)';
                            }}
                            onMouseLeave={(e) => {
                              (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)';
                              (e.currentTarget as HTMLElement).style.color = 'var(--text-muted)';
                            }}
                          >
                            <span style={{ fontSize: 20 }}>+</span>
                            <span>{ranked.length - maxPhotos} more</span>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
