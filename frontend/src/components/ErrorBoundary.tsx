/**
 * ErrorBoundary — catches React render errors and shows a styled
 * recovery screen instead of a blank white page.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props   { children: ReactNode; fallback?: ReactNode; }
interface State   { error: Error | null; }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[PhotoForge] Unhandled React error:', error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    if (this.props.fallback) return this.props.fallback;

    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', height: '100vh', gap: 24,
        background: 'var(--bg-primary)', color: 'var(--text-primary)',
        fontFamily: 'Inter, sans-serif', padding: 40,
      }}>
        <div style={{ fontSize: 56 }}>💥</div>
        <h2 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Something went wrong</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: 14, textAlign: 'center', maxWidth: 480, margin: 0 }}>
          An unexpected error occurred. Your data is safe — try reloading the page.
        </p>

        {/* Error details */}
        <details style={{ width: '100%', maxWidth: 600 }}>
          <summary style={{
            cursor: 'pointer', fontSize: 12,
            color: 'var(--text-muted)', marginBottom: 8, userSelect: 'none',
          }}>
            Show error details
          </summary>
          <pre style={{
            background: 'var(--bg-elevated)', border: '1px solid var(--border)',
            borderRadius: 8, padding: '12px 16px',
            fontSize: 11, color: 'var(--error)', overflowX: 'auto',
            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          }}>
            {this.state.error.message}
            {'\n\n'}
            {this.state.error.stack?.split('\n').slice(0, 8).join('\n')}
          </pre>
        </details>

        <div style={{ display: 'flex', gap: 12 }}>
          <button
            className="btn btn-primary"
            onClick={() => window.location.reload()}
          >
            ↺ Reload Page
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => this.setState({ error: null })}
          >
            Try Again
          </button>
        </div>
      </div>
    );
  }
}

/** Lightweight wrapper for a single page/section */
export function PageErrorBoundary({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary
      fallback={
        <div className="page-content">
          <div className="card" style={{ borderColor: 'rgba(239,68,68,0.3)', maxWidth: 480 }}>
            <div className="flex items-center gap-3 mb-3">
              <span style={{ fontSize: 28 }}>⚠️</span>
              <h3 style={{ color: 'var(--error)' }}>Page failed to load</h3>
            </div>
            <p className="text-sm text-muted mb-3">
              This section encountered an error. Try navigating back to the dashboard.
            </p>
            <button className="btn btn-secondary btn-sm" onClick={() => window.history.back()}>
              ← Go Back
            </button>
          </div>
        </div>
      }
    >
      {children}
    </ErrorBoundary>
  );
}
