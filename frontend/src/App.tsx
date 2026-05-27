import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import React from 'react';
import Dashboard     from './pages/Dashboard';
import NewProject    from './pages/NewProject';
import ProjectDetail from './pages/ProjectDetail';
import Viewer3D      from './pages/Viewer3D';
import Settings      from './pages/Settings';
import Queue         from './pages/Queue';
import ReportExport  from './pages/ReportExport';
import FlightPlanner from './pages/FlightPlanner';
import OrthoViewer   from './pages/OrthoViewer';
import BatchImport   from './pages/BatchImport';
import { jobsApi, systemApi, type Job } from './api';
import { ToastProvider } from './hooks/useToast';
import { ErrorBoundary, PageErrorBoundary } from './components/ErrorBoundary';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 5000 } },
});

// ─── NodeODM status indicator ─────────────────────────────────────────────────

function NodeODMStatus() {
  const [online, setOnline] = React.useState<boolean | null>(null);

  React.useEffect(() => {
    const check = async () => {
      try {
        const res = await systemApi.nodeodmStatus();
        setOnline(res.online);
      } catch { setOnline(false); }
    };
    check();
    const timer = setInterval(check, 5000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="flex items-center gap-2">
      <div style={{
        width: 8, height: 8, borderRadius: '50%',
        background: online === null ? '#64748b' : online ? 'var(--success)' : 'var(--error)',
        boxShadow: online ? '0 0 8px var(--success)' : 'none',
      }} />
      <span className="text-xs" style={{
        color: online ? 'var(--success)' : online === false ? 'var(--error)' : 'var(--text-muted)',
      }}>
        NodeODM {online === null ? 'Checking…' : online ? 'Online' : 'Offline'}
      </span>
    </div>
  );
}

// ─── Active jobs badge ────────────────────────────────────────────────────────

function ActiveJobsBadge() {
  const { data: queue = [] } = useQuery<Job[]>({
    queryKey: ['job-queue'],
    queryFn:  jobsApi.getQueue,
    refetchInterval: 5000,
  });
  if (queue.length === 0) return null;
  return (
    <span style={{
      marginLeft: 'auto', minWidth: 18, height: 18, borderRadius: 99,
      background: 'var(--accent)', color: '#000',
      fontSize: 10, fontWeight: 800,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: '0 5px',
    }}>
      {queue.length}
    </span>
  );
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────

const NAV_ITEMS = [
  { to: '/',               end: true,  icon: '⬡',  label: 'Dashboard'      },
  { to: '/projects/new',   end: false, icon: '＋',  label: 'New Project'    },
  { to: '/batch-import',   end: false, icon: '📦', label: 'Batch Import'   },
  { to: '/flight-planner', end: false, icon: '✈️',  label: 'Flight Planner' },
  { to: '/queue',          end: false, icon: '📋', label: 'Queue',  badge: true },
  { to: '/settings',       end: false, icon: '⚙',  label: 'Settings'       },
];

function Sidebar() {
  return (
    <aside className="sidebar">
      <div className="sidebar-logo">
        <div className="sidebar-logo-mark">📐</div>
        <div>
          <div className="sidebar-logo-text">PhotoForge</div>
          <div className="sidebar-logo-version">v0.5.0 — Local</div>
        </div>
      </div>

      <nav className="sidebar-nav">
        <span className="sidebar-nav-section">Navigation</span>
        {NAV_ITEMS.map(item => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) => `sidebar-nav-item ${isActive ? 'active' : ''}`}
          >
            <span>{item.icon}</span>
            {item.label}
            {item.badge && <ActiveJobsBadge />}
          </NavLink>
        ))}
      </nav>

      <div className="sidebar-footer">
        <div className="card" style={{ padding: '12px' }}>
          <div className="text-xs text-muted mb-2">Processing Engine</div>
          <NodeODMStatus />
        </div>
      </div>
    </aside>
  );
}

// ─── App Shell ────────────────────────────────────────────────────────────────

function AppShell() {
  return (
    <div className="app-shell">
      <Sidebar />
      <div className="main-content">
        <Routes>
          <Route path="/"                   element={<PageErrorBoundary><Dashboard /></PageErrorBoundary>}     />
          <Route path="/projects/new"       element={<PageErrorBoundary><NewProject /></PageErrorBoundary>}    />
          <Route path="/projects/:id"       element={<PageErrorBoundary><ProjectDetail /></PageErrorBoundary>} />
          <Route path="/viewer/:jobId"      element={<PageErrorBoundary><Viewer3D /></PageErrorBoundary>}      />
          <Route path="/settings"           element={<PageErrorBoundary><Settings /></PageErrorBoundary>}      />
          <Route path="/queue"              element={<PageErrorBoundary><Queue /></PageErrorBoundary>}          />
          <Route path="/report/:jobId"      element={<PageErrorBoundary><ReportExport /></PageErrorBoundary>}  />
          <Route path="/flight-planner"     element={<PageErrorBoundary><FlightPlanner /></PageErrorBoundary>} />
          <Route path="/ortho/:jobId"       element={<PageErrorBoundary><OrthoViewer /></PageErrorBoundary>}   />
          <Route path="/batch-import"       element={<PageErrorBoundary><BatchImport /></PageErrorBoundary>}   />
        </Routes>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <BrowserRouter>
            <AppShell />
          </BrowserRouter>
        </ToastProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
