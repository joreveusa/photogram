/**
 * MiniMap — renders a small Leaflet map centred on a project's EXIF bounding box.
 * Shows the flight area as a teal rectangle with a subtle glow.
 *
 * Usage:
 *   <MiniMap bbox={{ min_lat, max_lat, min_lon, max_lon }} height={180} />
 */

import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

export interface BBox {
  min_lat: number;
  max_lat: number;
  min_lon: number;
  max_lon: number;
}

interface MiniMapProps {
  bbox: BBox;
  height?: number;
  interactive?: boolean;
}

// Fix Leaflet's default icon paths broken by bundlers
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
});

export default function MiniMap({ bbox, height = 180, interactive = false }: MiniMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    if (mapRef.current) return; // already initialised — don't double-init

    const bounds: L.LatLngBoundsExpression = [
      [bbox.min_lat, bbox.min_lon],
      [bbox.max_lat, bbox.max_lon],
    ];

    const map = L.map(containerRef.current, {
      zoomControl: interactive,
      scrollWheelZoom: interactive,
      dragging: interactive,
      touchZoom: interactive,
      doubleClickZoom: interactive,
      boxZoom: false,
      keyboard: false,
      attributionControl: false,
    });

    mapRef.current = map;

    // Dark satellite-ish tile layer (CartoDB Dark Matter)
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 19,
      subdomains: 'abcd',
    }).addTo(map);

    // Flight area rectangle
    L.rectangle(bounds, {
      color: '#00d4aa',
      weight: 2,
      fillColor: '#00d4aa',
      fillOpacity: 0.12,
      dashArray: '4 4',
    }).addTo(map);

    map.fitBounds(bounds, { padding: [16, 16] });

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [bbox.min_lat, bbox.max_lat, bbox.min_lon, bbox.max_lon, interactive]);

  return (
    <div
      ref={containerRef}
      style={{
        height: height || 180,
        minHeight: 120,
        width: '100%',
        borderRadius: 'var(--radius-md)',
        overflow: 'hidden',
        background: '#0a0d14',
      }}
    />
  );
}
