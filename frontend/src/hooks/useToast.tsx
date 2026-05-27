/**
 * useToast — global toast notification hook.
 * Usage:
 *   const { toast } = useToast();
 *   toast.success('Project created!');
 *   toast.error('Upload failed', 'Network error');
 *   toast.info('Processing started');
 */

import { useState, useCallback, createContext, useContext, useRef } from 'react';

export type ToastType = 'success' | 'error' | 'info' | 'warning';

export interface Toast {
  id: string;
  type: ToastType;
  title: string;
  body?: string;
  duration?: number;
}

interface ToastContextValue {
  toasts: Toast[];
  addToast: (type: ToastType, title: string, body?: string, duration?: number) => void;
  removeToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const removeToast = useCallback((id: string) => {
    clearTimeout(timers.current[id]);
    delete timers.current[id];
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const addToast = useCallback((
    type: ToastType,
    title: string,
    body?: string,
    duration = 4000,
  ) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setToasts(prev => [...prev.slice(-4), { id, type, title, body, duration }]);
    if (duration > 0) {
      timers.current[id] = setTimeout(() => removeToast(id), duration);
    }
  }, [removeToast]);

  return (
    <ToastContext.Provider value={{ toasts, addToast, removeToast }}>
      {children}
      <ToastContainer toasts={toasts} onRemove={removeToast} />
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be inside ToastProvider');

  const { addToast } = ctx;
  return {
    toast: {
      success: (title: string, body?: string) => addToast('success', title, body),
      error:   (title: string, body?: string) => addToast('error',   title, body, 6000),
      info:    (title: string, body?: string) => addToast('info',    title, body),
      warning: (title: string, body?: string) => addToast('warning', title, body, 5000),
    },
  };
}

// ─── Toast Container UI ───────────────────────────────────────────────────────

const ICONS: Record<ToastType, string> = {
  success: '✓',
  error:   '✕',
  info:    'ℹ',
  warning: '⚠',
};

const COLORS: Record<ToastType, string> = {
  success: 'var(--success)',
  error:   'var(--error)',
  info:    'var(--info)',
  warning: 'var(--warning)',
};

function ToastContainer({ toasts, onRemove }: { toasts: Toast[]; onRemove: (id: string) => void }) {
  if (toasts.length === 0) return null;

  return (
    <div className="toast-container">
      {toasts.map(t => (
        <div key={t.id} className={`toast toast-${t.type}`}>
          <span style={{
            width: 20, height: 20, borderRadius: '50%',
            background: COLORS[t.type],
            color: '#000', fontWeight: 800, fontSize: 11,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
          }}>
            {ICONS[t.type]}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 13 }}>{t.title}</div>
            {t.body && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{t.body}</div>}
          </div>
          <button
            onClick={() => onRemove(t.id)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--text-muted)', fontSize: 16, padding: '0 2px',
              lineHeight: 1, flexShrink: 0,
            }}
          >×</button>
        </div>
      ))}
    </div>
  );
}
