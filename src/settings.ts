/**
 * Settings — tiny typed load/save for user preferences (localStorage).
 *
 * `defaultPresetMin: null` means the Space shortcut keeps the historical
 * behavior of starting the last-used duration.
 */
export interface Settings {
  /** Play the bundled focus track while the timer runs (opt-out). */
  music: boolean;
  /** Focus-music volume, 0–1. */
  volume: number;
  /** Preset (minutes) the Space shortcut starts from idle; null = last used. */
  defaultPresetMin: number | null;
}

const SETTINGS_KEY = 'stint.settings';

const DEFAULTS: Settings = { music: true, volume: 0.35, defaultPresetMin: null };

export function loadSettings(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    if (!saved) return { ...DEFAULTS };
    return {
      music: typeof saved.music === 'boolean' ? saved.music : DEFAULTS.music,
      volume:
        typeof saved.volume === 'number'
          ? Math.max(0, Math.min(1, saved.volume))
          : DEFAULTS.volume,
      defaultPresetMin:
        typeof saved.defaultPresetMin === 'number' ? saved.defaultPresetMin : null,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable — settings just won't persist */
  }
}
