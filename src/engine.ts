/**
 * TimerEngine — the timestamp-based countdown state machine.
 * modes: idle | running | paused | done
 *
 * Accuracy: on start we store an absolute end timestamp; the rAF tick derives
 * `remaining = endTime - now` rather than decrementing a counter. A setTimeout
 * fallback guarantees completion fires even when rAF is throttled in a
 * hidden/backgrounded window.
 *
 * Persistence: lifecycle changes (not every tick) are written to localStorage;
 * a running timer is reconstructed from its end timestamp on relaunch, and a
 * timer that expired while away resets to idle WITHOUT alarming.
 */
import type { AlarmPort } from './alarm';
import type { MusicPort } from './music';

export type Mode = 'idle' | 'running' | 'paused' | 'done';

const DEFAULT_TOTAL = 25 * 60;
const PERSIST_KEY = 'stint.timer';

interface PersistedState {
  total: number;
  mode: Mode;
  endTime: number;
  remaining: number | null;
}

export class TimerEngine {
  total = DEFAULT_TOTAL;
  remaining = DEFAULT_TOTAL;
  mode: Mode = 'idle';
  editing = false;

  private endTime = 0;
  private raf = 0;
  private fallback: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private alarm: AlarmPort,
    private music: MusicPort,
    private onChange: () => void,
    // Prevents macOS App Nap from suspending the process (and freezing the rAF
    // tick / setTimeout fallback) while a session runs or the alarm rings —
    // without it, a backgrounded Spotify session produces no webview audio, so
    // the OS naps us and completion never fires. No-op outside Tauri/macOS.
    private setKeepAwake: (on: boolean) => void = () => {},
  ) {}

  persist(): void {
    try {
      const data: PersistedState = {
        total: this.total,
        mode: this.mode,
        endTime: this.endTime,
        remaining: this.mode === 'running' ? null : this.remaining,
      };
      localStorage.setItem(PERSIST_KEY, JSON.stringify(data));
    } catch {
      /* storage unavailable — timer still works, just not across relaunches */
    }
  }

  restore(): void {
    let saved: PersistedState | null = null;
    try {
      saved = JSON.parse(localStorage.getItem(PERSIST_KEY) || 'null');
    } catch {
      saved = null;
    }
    if (!saved) return;

    this.total = saved.total || DEFAULT_TOTAL;
    this.mode = saved.mode || 'idle';
    this.remaining = saved.remaining != null ? saved.remaining : this.total;

    if (saved.mode === 'running' && saved.endTime) {
      const left = (saved.endTime - Date.now()) / 1000;
      if (left > 0) {
        this.remaining = left;
        this.endTime = saved.endTime;
      } else {
        // expired while away — reset to idle WITHOUT alarming
        this.mode = 'idle';
        this.remaining = this.total;
        this.endTime = 0;
      }
    } else if (saved.mode === 'done') {
      // a completed-but-not-dismissed session reopens as idle (no auto-alarm)
      this.mode = 'idle';
      this.remaining = this.total;
    }

    if (this.mode === 'running') {
      this.setKeepAwake(true);
      this.loop();
      // Resuming a still-running session on relaunch brings the music back;
      // the adapter handles autoplay-policy rejection internally.
      this.music.start();
    }
  }

  private clearTimers(): void {
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    if (this.fallback !== null) {
      clearTimeout(this.fallback);
      this.fallback = null;
    }
  }

  private loop(): void {
    if (this.mode !== 'running') return;
    this.clearTimers();
    const tick = () => {
      const left = (this.endTime - Date.now()) / 1000;
      if (left <= 0) {
        this.remaining = 0;
        this.complete();
        return;
      }
      this.remaining = left;
      this.onChange();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
    // setTimeout fallback: fires completion even if rAF is throttled while hidden
    const ms = Math.max(0, this.endTime - Date.now());
    this.fallback = setTimeout(() => {
      if (this.mode === 'running' && Date.now() >= this.endTime) {
        this.remaining = 0;
        this.complete();
      }
    }, ms + 60);
  }

  startWith(sec: number): void {
    // Always silence any active completion chime before starting a new session
    // (covers starting a preset straight from the ringing done state).
    this.alarm.stop();
    this.alarm.unlock();
    this.setKeepAwake(true);
    this.music.start();
    this.total = sec;
    this.remaining = sec;
    this.endTime = Date.now() + sec * 1000;
    this.mode = 'running';
    this.editing = false;
    this.loop();
    this.persist();
    this.onChange();
  }

  start(): void {
    this.startWith(this.total);
  }

  pause(): void {
    this.clearTimers();
    this.setKeepAwake(false);
    this.music.pause();
    this.remaining = Math.max(0, (this.endTime - Date.now()) / 1000);
    this.mode = 'paused';
    this.persist();
    this.onChange();
  }

  resume(): void {
    this.setKeepAwake(true);
    this.music.resume();
    this.endTime = Date.now() + this.remaining * 1000;
    this.mode = 'running';
    this.loop();
    this.persist();
    this.onChange();
  }

  cancel(): void {
    this.clearTimers();
    this.setKeepAwake(false);
    this.alarm.stop();
    this.music.stop();
    this.remaining = this.total;
    this.endTime = 0;
    this.mode = 'idle';
    this.persist();
    this.onChange();
  }

  private complete(): void {
    this.clearTimers();
    this.mode = 'done';
    // Deliberately keep the process awake here: the chime loops for up to 10s
    // and a backgrounded done-state produces no other webview audio, so
    // releasing now could let App Nap suspend us mid-alarm. stopSound() (or
    // starting a new session) releases it.
    // Music out before the chime comes in.
    this.music.stop();
    this.alarm.start();
    this.persist();
    this.onChange();
  }

  restart(): void {
    this.alarm.stop();
    this.startWith(this.total);
  }

  stopSound(): void {
    this.alarm.stop();
    this.music.stop();
    this.setKeepAwake(false);
    this.clearTimers();
    this.mode = 'idle';
    this.remaining = this.total;
    this.endTime = 0;
    this.persist();
    this.onChange();
  }

  /** Set a new duration while idle (custom-duration commit). */
  setDuration(sec: number): void {
    this.total = sec;
    this.remaining = sec;
    this.persist();
  }
}
