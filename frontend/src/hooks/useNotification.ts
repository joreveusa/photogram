/**
 * useNotification — sends desktop notifications via Tauri when running as
 * a native app, falls back to the Web Notifications API in the browser.
 *
 * Usage:
 *   const { notifyJobComplete } = useNotification();
 *   notifyJobComplete('Survey Site A', 'completed', '14m 22s');
 */

import { useCallback } from 'react';

// Detect Tauri environment
const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;

async function sendTauriNotification(title: string, body: string) {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('notify_job_complete', { title, body });
  } catch {
    // Tauri invoke failed — fall back to browser notification
    sendBrowserNotification(title, body);
  }
}

function sendBrowserNotification(title: string, body: string) {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted') {
    new Notification(title, { body, icon: '/favicon.ico' });
  } else if (Notification.permission !== 'denied') {
    Notification.requestPermission().then(perm => {
      if (perm === 'granted') new Notification(title, { body });
    });
  }
}

export function useNotification() {
  const notify = useCallback((title: string, body: string) => {
    // Respect user preference stored in settings
    const notifEnabled = localStorage.getItem('pf_notifications') !== 'false';
    if (!notifEnabled) return;

    if (isTauri) {
      sendTauriNotification(title, body);
    } else {
      sendBrowserNotification(title, body);
    }
  }, []);

  const notifyJobComplete = useCallback((
    projectName: string,
    status: 'completed' | 'failed',
    duration?: string,
  ) => {
    if (status === 'completed') {
      notify(
        `✅ ${projectName} — Complete`,
        duration ? `Processing finished in ${duration}` : 'All deliverables ready',
      );
    } else {
      notify(
        `❌ ${projectName} — Failed`,
        'Check the job log for details',
      );
    }
  }, [notify]);

  return { notify, notifyJobComplete };
}
