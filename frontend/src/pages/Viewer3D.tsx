import { Suspense, useRef, useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, useGLTF, Grid, Environment, Stats, Center, GizmoHelper, GizmoViewport } from '@react-three/drei';
import * as THREE from 'three';
import { jobsApi, type JobOutput } from '../api';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

// ─── Viewer Mode ──────────────────────────────────────────────────────────────

type ViewMode = 'potree' | 'mesh' | 'none';

// ─── GLTF / GLB / OBJ Mesh Viewer ────────────────────────────────────────────

function Scene({ url }: { url: string }) {
  const { scene } = useGLTF(url);
  useEffect(() => {
    // Auto-scale: fit the mesh into a unit box
    const box = new THREE.Box3().setFromObject(scene);
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    if (maxDim > 0) scene.scale.setScalar(10 / maxDim);
    const center = box.getCenter(new THREE.Vector3());
    scene.position.sub(center.multiplyScalar(10 / maxDim));
  }, [scene]);
  return <primitive object={scene} />;
}

function RotatingFallbackCube() {
  const meshRef = useRef<any>(null);
  useFrame((_, delta) => {
    if (meshRef.current) {
      meshRef.current.rotation.x += delta * 0.3;
      meshRef.current.rotation.y += delta * 0.5;
    }
  });
  return (
    <mesh ref={meshRef}>
      <boxGeometry args={[2, 2, 2]} />
      <meshStandardMaterial color="#00d4aa" wireframe opacity={0.6} transparent />
    </mesh>
  );
}

// ─── Potree iframe Viewer ─────────────────────────────────────────────────────

function PotreeViewer({ eptUrl, pointBudget }: { eptUrl: string; pointBudget: number }) {
  const src = `/potree_viewer.html?ept=${encodeURIComponent(eptUrl)}&budget=${pointBudget}`;
  return (
    <iframe
      key={src}
      src={src}
      style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
      title="Point Cloud Viewer"
      allow="fullscreen"
    />
  );
}

// ─── Mesh Viewer Controls ─────────────────────────────────────────────────────

function MeshViewerControls({
  onReset,
  showStats,
  onToggleStats,
  wireframe,
  onToggleWireframe,
}: {
  onReset: () => void;
  showStats: boolean;
  onToggleStats: () => void;
  wireframe: boolean;
  onToggleWireframe: () => void;
}) {
  return (
    <div style={{
      position: 'absolute', top: 16, right: 16,
      display: 'flex', flexDirection: 'column', gap: 8, zIndex: 10,
    }}>
      <button className="btn btn-secondary btn-sm" onClick={onReset}>⌂ Reset</button>
      <button
        className={`btn btn-sm ${wireframe ? 'btn-primary' : 'btn-secondary'}`}
        onClick={onToggleWireframe}
      >
        ◻ Wire
      </button>
      <button
        className={`btn btn-sm ${showStats ? 'btn-primary' : 'btn-secondary'}`}
        onClick={onToggleStats}
      >
        📊 Stats
      </button>
    </div>
  );
}

// ─── Potree Controls Overlay ──────────────────────────────────────────────────

function PotreeControls({ pointBudget, onBudgetChange }: {
  pointBudget: number;
  onBudgetChange: (v: number) => void;
}) {
  const BUDGETS = [500_000, 1_000_000, 2_000_000, 5_000_000, 10_000_000];
  return (
    <div style={{
      position: 'absolute', top: 16, right: 16, zIndex: 10,
      background: 'var(--bg-glass)', backdropFilter: 'blur(12px)',
      borderRadius: 'var(--radius-lg)', padding: '10px 14px',
      border: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <div className="text-xs text-muted" style={{ marginBottom: 4 }}>Point Budget</div>
      {BUDGETS.map(b => (
        <button
          key={b}
          className={`btn btn-sm ${pointBudget === b ? 'btn-primary' : 'btn-ghost'}`}
          style={{ fontSize: 11, padding: '3px 10px' }}
          onClick={() => onBudgetChange(b)}
        >
          {b >= 1_000_000 ? `${b / 1_000_000}M` : `${b / 1_000}K`}
        </button>
      ))}
    </div>
  );
}

// ─── Output Selector ──────────────────────────────────────────────────────────

function OutputSelector({ outputs, selected, onSelect }: {
  outputs: JobOutput[];
  selected: JobOutput | null;
  onSelect: (o: JobOutput) => void;
}) {
  const viewable = outputs.filter(o => ['mesh_glb', 'ept'].includes(o.output_type));
  if (viewable.length === 0) return null;

  const label = (o: JobOutput) => {
    if (o.output_type === 'mesh_glb') return '🔷 3D Mesh (GLB)';
    if (o.output_type === 'ept') return '✨ Potree Stream';
    return o.output_type;
  };

  return (
    <div style={{
      position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)',
      display: 'flex', gap: 8, zIndex: 10, background: 'var(--bg-glass)',
      backdropFilter: 'blur(12px)', borderRadius: 'var(--radius-lg)',
      padding: '8px 12px', border: '1px solid var(--border)',
    }}>
      {viewable.map(o => (
        <button
          key={o.id}
          className={`btn btn-sm ${selected?.id === o.id ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => onSelect(o)}
        >
          {label(o)}
        </button>
      ))}
    </div>
  );
}

// ─── 3D Viewer Page ───────────────────────────────────────────────────────────

export default function Viewer3D() {
  const { jobId } = useParams<{ jobId: string }>();
  const navigate = useNavigate();
  const [selectedOutput, setSelectedOutput] = useState<JobOutput | null>(null);
  const [showStats, setShowStats] = useState(false);
  const [wireframe, setWireframe] = useState(false);
  const [pointBudget, setPointBudget] = useState(2_000_000);
  const controlsRef = useRef<any>(null);

  const { data: outputs = [] } = useQuery<JobOutput[]>({
    queryKey: ['job-outputs', jobId],
    queryFn: () => jobsApi.getOutputs(jobId!),
    refetchInterval: 10000,
  });

  // Auto-select: prefer EPT (Potree stream), then GLB mesh
  useEffect(() => {
    if (outputs.length > 0 && !selectedOutput) {
      const ept = outputs.find((o: JobOutput) => o.output_type === 'ept');
      const glb = outputs.find((o: JobOutput) => o.output_type === 'mesh_glb');
      setSelectedOutput(ept || glb || null);
    }
  }, [outputs, selectedOutput]);

  // Determine view mode
  const viewMode: ViewMode =
    selectedOutput?.output_type === 'ept'      ? 'potree' :
    selectedOutput?.output_type === 'mesh_glb' ? 'mesh'   : 'none';

  // URLs
  const meshUrl = viewMode === 'mesh' && selectedOutput
    ? `${API_URL}/jobs/${jobId}/download/${selectedOutput.output_type}`
    : null;

  const eptUrl = viewMode === 'potree' && selectedOutput
    ? `${API_URL}/jobs/${jobId}/ept/ept.json`
    : null;

  const handleReset = () => {
    controlsRef.current?.reset();
  };

  const hasLaz = outputs.some((o: JobOutput) => o.output_type === 'point_cloud');
  const hasGlb = outputs.some((o: JobOutput) => o.output_type === 'mesh_glb');

  return (
    <div style={{ width: '100%', height: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* Topbar */}
      <div className="topbar">
        <div className="flex items-center gap-3">
          <button className="btn btn-ghost btn-sm" onClick={() => navigate(-1)}>← Back</button>
          <span className="topbar-title">3D Viewer</span>
          {selectedOutput && (
            <span className="badge badge-indexing">{selectedOutput.output_type.replace('_', ' ')}</span>
          )}
        </div>
        <div className="topbar-right">
          {hasGlb && (
            <a
              href={`${API_URL}/jobs/${jobId}/download/mesh_glb`}
              className="btn btn-secondary btn-sm"
              download
            >
              ↓ Download GLB
            </a>
          )}
          {hasLaz && (
            <a
              href={`${API_URL}/jobs/${jobId}/download/point_cloud`}
              className="btn btn-ghost btn-sm"
              download
            >
              ↓ Download LAZ
            </a>
          )}
        </div>
      </div>

      {/* Viewer */}
      <div style={{ flex: 1, position: 'relative', background: '#070a12' }}>

        {/* ── Potree iframe ── */}
        {viewMode === 'potree' && eptUrl && (
          <>
            <PotreeViewer eptUrl={eptUrl} pointBudget={pointBudget} />
            <PotreeControls pointBudget={pointBudget} onBudgetChange={setPointBudget} />
          </>
        )}

        {/* ── Three.js mesh viewer ── */}
        {viewMode === 'mesh' && (
          <>
            <Canvas
              camera={{ position: [8, 6, 8], fov: 55 }}
              shadows
              gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.2 }}
            >
              <color attach="background" args={['#070a12']} />
              <ambientLight intensity={0.5} />
              <directionalLight position={[15, 15, 8]} intensity={1.5} castShadow
                shadow-mapSize-width={2048} shadow-mapSize-height={2048} />
              <directionalLight position={[-10, -5, -5]} intensity={0.3} />

              <Suspense fallback={<RotatingFallbackCube />}>
                {meshUrl ? (
                  <Center>
                    <Scene url={meshUrl} />
                  </Center>
                ) : (
                  <RotatingFallbackCube />
                )}
              </Suspense>

              <Grid
                args={[100, 100]}
                cellColor="#1a2235"
                sectionColor="#243050"
                fadeDistance={60}
                position={[0, -5, 0]}
              />

              <OrbitControls ref={controlsRef} makeDefault enableDamping dampingFactor={0.05} />
              <Environment preset="night" />
              {showStats && <Stats />}

              <GizmoHelper alignment="bottom-right" margin={[72, 72]}>
                <GizmoViewport labelColor="white" axisHeadScale={0.9} />
              </GizmoHelper>
            </Canvas>

            <MeshViewerControls
              onReset={handleReset}
              showStats={showStats}
              onToggleStats={() => setShowStats(v => !v)}
              wireframe={wireframe}
              onToggleWireframe={() => setWireframe(v => !v)}
            />

            <div style={{
              position: 'absolute', bottom: 56, left: 16,
              background: 'var(--bg-glass)', backdropFilter: 'blur(12px)',
              borderRadius: 'var(--radius-md)', padding: '8px 12px',
              border: '1px solid var(--border)', fontSize: 12,
              color: 'var(--text-muted)', pointerEvents: 'none',
            }}>
              🖱 Left drag: Rotate &nbsp;·&nbsp; Right drag: Pan &nbsp;·&nbsp; Scroll: Zoom
            </div>
          </>
        )}

        {/* ── No outputs ── */}
        {viewMode === 'none' && (
          <div style={{
            position: 'absolute', top: '50%', left: '50%',
            transform: 'translate(-50%, -50%)',
            textAlign: 'center', zIndex: 5,
          }}>
            <div style={{ fontSize: 56, marginBottom: 16, opacity: 0.3 }}>☁️</div>
            <div style={{ color: 'var(--text-muted)', fontSize: 15 }}>
              {(outputs as JobOutput[]).length === 0
                ? 'No outputs available yet — processing may still be running'
                : 'Select an output above to view it'}
            </div>
          </div>
        )}

        <OutputSelector outputs={outputs as JobOutput[]} selected={selectedOutput} onSelect={setSelectedOutput} />
      </div>
    </div>
  );
}
