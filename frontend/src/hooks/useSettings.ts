/**
 * useSettings — persists all PhotoForge configuration to localStorage.
 * Provides typed access and a single save function.
 *
 * Keys are namespaced with `pf_` prefix.
 */

import { useState, useCallback } from 'react';

export interface PhotoForgeSettings {
  apiUrl:        string;
  nodeoUrl:      string;
  wsUrl:         string;
  splitSize:     number;
  splitOverlap:  number;
  defaultPreset: 'fast_preview' | 'survey_grade' | 'high_fidelity';
  notifications: boolean;
  autoStartJobs: boolean;
  theme:         'dark';    // reserved for future light mode
}

const DEFAULTS: PhotoForgeSettings = {
  apiUrl:        'http://localhost:8000',
  nodeoUrl:      'http://localhost:3000',
  wsUrl:         'ws://localhost:8000',
  splitSize:     200,
  splitOverlap:  50,
  defaultPreset: 'survey_grade',
  notifications: true,
  autoStartJobs: false,
  theme:         'dark',
};

function load(): PhotoForgeSettings {
  const s = { ...DEFAULTS };
  const raw = localStorage.getItem('pf_settings');
  if (raw) {
    try { Object.assign(s, JSON.parse(raw)); } catch { /* ignore */ }
  }
  // Migrate legacy keys
  const legacyApi = localStorage.getItem('pf_api_url');
  if (legacyApi) { s.apiUrl = legacyApi; localStorage.removeItem('pf_api_url'); }
  return s;
}

export function useSettings() {
  const [settings, setSettings] = useState<PhotoForgeSettings>(load);
  const [dirty, setDirty] = useState(false);

  const update = useCallback(<K extends keyof PhotoForgeSettings>(
    key: K,
    value: PhotoForgeSettings[K],
  ) => {
    setSettings(prev => ({ ...prev, [key]: value }));
    setDirty(true);
  }, []);

  const save = useCallback((overrides?: Partial<PhotoForgeSettings>) => {
    const toSave = overrides ? { ...settings, ...overrides } : settings;
    localStorage.setItem('pf_settings', JSON.stringify(toSave));
    // Keep notifications flag as a standalone key for useNotification
    localStorage.setItem('pf_notifications', String(toSave.notifications));
    setDirty(false);
    return toSave;
  }, [settings]);

  const reset = useCallback(() => {
    setSettings(DEFAULTS);
    setDirty(true);
  }, []);

  return { settings, update, save, reset, dirty };
}

/** Read a single setting without the hook (for use outside components). */
export function getSetting<K extends keyof PhotoForgeSettings>(key: K): PhotoForgeSettings[K] {
  return load()[key];
}
