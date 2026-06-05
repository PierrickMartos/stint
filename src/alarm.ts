/**
 * AlarmAdapter — ALL completion side-effects live here, so the rest of the
 * app never touches audio or notification APIs directly.
 *
 * Sound: a soft two-note WebAudio chime (659.25 & 987.77 Hz) with gentle
 * exponential decay, repeating every 2.6s until dismissed or 10s elapse.
 *
 * Notification: native via @tauri-apps/plugin-notification when running in
 * the Tauri shell; a no-op in the browser preview.
 */
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';
import { isTauri } from './shell';

export interface AlarmPort {
  /** Unlock the audio context on the first user Start gesture. */
  unlock(): void;
  /** Begin the completion alarm (chime loop + one native notification). */
  start(): void;
  /** Silence the alarm. Safe to call when not ringing. */
  stop(): void;
}

const CHIME_NOTES_HZ = [659.25, 987.77];
const CHIME_REPEAT_MS = 2600;
const AUTO_STOP_MS = 10_000;

let ctx: AudioContext | null = null;
let intervalId: ReturnType<typeof setInterval> | null = null;
let autoStopId: ReturnType<typeof setTimeout> | null = null;

function getAudio(): AudioContext | null {
  if (!ctx) {
    try {
      ctx = new AudioContext();
    } catch {
      ctx = null;
    }
  }
  if (ctx && ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

function chime(): void {
  const c = getAudio();
  if (!c) return;
  const now = c.currentTime;
  CHIME_NOTES_HZ.forEach((f, i) => {
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = 'sine';
    o.frequency.value = f;
    const t = now + i * 0.16;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.18, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.3);
    o.connect(g).connect(c.destination);
    o.start(t);
    o.stop(t + 1.4);
  });
}

async function notify(): Promise<void> {
  if (!isTauri) return;
  try {
    let granted = await isPermissionGranted();
    if (!granted) {
      granted = (await requestPermission()) === 'granted';
    }
    if (granted) {
      sendNotification({ title: 'Stint', body: 'Time’s up' });
    }
  } catch {
    // Notifications are best-effort — the in-app alarm state is the source of truth.
  }
}

export const AlarmAdapter: AlarmPort = {
  unlock() {
    getAudio();
  },
  start() {
    this.stop();
    chime();
    void notify();
    intervalId = setInterval(chime, CHIME_REPEAT_MS);
    autoStopId = setTimeout(() => this.stop(), AUTO_STOP_MS);
  },
  stop() {
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
    if (autoStopId !== null) {
      clearTimeout(autoStopId);
      autoStopId = null;
    }
  },
};
