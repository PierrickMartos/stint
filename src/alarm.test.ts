/**
 * AlarmAdapter chime-loop behavior, observed through a fake AudioContext that
 * counts oscillators (one chime = 2 notes = 2 oscillators). Module state is
 * reset per test via vi.resetModules() + dynamic import.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlarmPort } from './alarm';

vi.mock('./shell', () => ({ isTauri: false })); // notify() becomes a no-op
vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
}));

let oscillatorsCreated = 0;
const chimesPlayed = () => oscillatorsCreated / 2;

// Per-test knobs for modelling a context WebKit has killed mid-session.
let initialState = 'running';
let resumeImpl: ((ctx: FakeAudioContext) => Promise<void>) | null = null;
let contextsConstructed = 0;
let statesAtNoteScheduling: string[] = [];

class FakeAudioContext {
  state = initialState;
  currentTime = 0;
  destination = {};
  constructor() {
    contextsConstructed++;
  }
  resume(): Promise<void> {
    if (resumeImpl) return resumeImpl(this);
    // Like the real API, the state flips only when the promise resolves.
    return Promise.resolve().then(() => {
      this.state = 'running';
    });
  }
  close(): Promise<void> {
    this.state = 'closed';
    return Promise.resolve();
  }
  createOscillator() {
    oscillatorsCreated++;
    statesAtNoteScheduling.push(this.state);
    const node = {
      type: '',
      frequency: { value: 0 },
      connect: (target: unknown) => target,
      start() {},
      stop() {},
    };
    return node;
  }
  createGain() {
    return {
      gain: {
        setValueAtTime() {},
        linearRampToValueAtTime() {},
        exponentialRampToValueAtTime() {},
      },
      connect: (target: unknown) => target,
    };
  }
}

let alarm: AlarmPort;

beforeEach(async () => {
  vi.useFakeTimers();
  oscillatorsCreated = 0;
  initialState = 'running';
  resumeImpl = null;
  contextsConstructed = 0;
  statesAtNoteScheduling = [];
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.resetModules();
  alarm = (await import('./alarm')).AlarmAdapter;
});

afterEach(() => {
  alarm.stop();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('AlarmAdapter', () => {
  it('chimes immediately and repeats every 2.6s', () => {
    alarm.start();
    expect(chimesPlayed()).toBe(1);
    vi.advanceTimersByTime(5_300); // t=2.6s and t=5.2s
    expect(chimesPlayed()).toBe(3);
  });

  it('auto-stops after 10 seconds', () => {
    alarm.start();
    vi.advanceTimersByTime(10_000); // chimes at 0, 2.6, 5.2, 7.8
    expect(chimesPlayed()).toBe(4);
    vi.advanceTimersByTime(60_000);
    expect(chimesPlayed()).toBe(4); // silence after the auto-stop
  });

  it('stop() silences the loop immediately', () => {
    alarm.start();
    vi.advanceTimersByTime(3_000);
    expect(chimesPlayed()).toBe(2);
    alarm.stop();
    vi.advanceTimersByTime(30_000);
    expect(chimesPlayed()).toBe(2);
  });

  it('a dismissed alarm cannot cut a later alarm short (auto-stop timer is cleared)', () => {
    alarm.start(); // would auto-stop at t=10s if left alone
    vi.advanceTimersByTime(5_000);
    alarm.stop();
    vi.advanceTimersByTime(1_000); // t=6s
    alarm.start(); // this alarm's own auto-stop lands at t=16s
    const base = chimesPlayed();
    vi.advanceTimersByTime(6_000); // t=12s — past the FIRST alarm's would-be cutoff
    expect(chimesPlayed()).toBe(base + 2); // chimed at t=8.6 and t=11.2 — still ringing
    vi.advanceTimersByTime(60_000);
    const total = chimesPlayed();
    expect(total - base).toBe(3); // rang its full 10s (t=8.6, 11.2, 13.8), then silence
  });

  it('start() while already ringing restarts cleanly instead of stacking intervals', () => {
    alarm.start();
    vi.advanceTimersByTime(3_000);
    alarm.start();
    const base = chimesPlayed();
    vi.advanceTimersByTime(2_600);
    expect(chimesPlayed()).toBe(base + 1); // one interval, not two
  });

  // WebKit suspends (or marks 'interrupted' — its non-standard state) an
  // AudioContext that idled through a whole session: by completion time the
  // context unlocked at Start is dead, and notes scheduled into it never
  // sound. The chime must bring the context back to 'running' FIRST and only
  // then schedule notes.
  describe('dead-context recovery (long idle session)', () => {
    const flushMicrotasks = async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    };

    it("resumes a context in WebKit's 'interrupted' state before scheduling notes", async () => {
      initialState = 'interrupted';
      alarm.unlock();
      alarm.start();
      await flushMicrotasks();
      expect(chimesPlayed()).toBe(1);
      expect(statesAtNoteScheduling).toEqual(['running', 'running']);
    });

    it('schedules notes only after a suspended context has actually resumed', async () => {
      initialState = 'suspended';
      alarm.unlock();
      alarm.start();
      await flushMicrotasks();
      expect(chimesPlayed()).toBe(1);
      expect(statesAtNoteScheduling).toEqual(['running', 'running']);
    });

    it('rebuilds the context from scratch when resume() is rejected', async () => {
      initialState = 'interrupted';
      alarm.unlock(); // creates context #1, stuck interrupted
      resumeImpl = (ctx) => {
        if (contextsConstructed === 1) return Promise.reject(new Error('interrupted'));
        return Promise.resolve().then(() => {
          ctx.state = 'running';
        });
      };
      initialState = 'suspended'; // replacement starts suspended (no gesture)
      alarm.start();
      await flushMicrotasks();
      expect(contextsConstructed).toBe(2);
      expect(chimesPlayed()).toBe(1);
      expect(statesAtNoteScheduling).toEqual(['running', 'running']);
    });

    it('a healthy running context still chimes synchronously', () => {
      alarm.start();
      expect(chimesPlayed()).toBe(1); // no microtask flush needed
    });

    it('recovery that finishes after the alarm was dismissed stays silent', async () => {
      initialState = 'interrupted';
      alarm.unlock();
      let finishResume: () => void = () => {};
      resumeImpl = (ctx) =>
        new Promise<void>((resolve) => {
          finishResume = () => {
            ctx.state = 'running';
            resolve();
          };
        });
      alarm.start();
      alarm.stop(); // dismissed (or auto-stopped) while resume is in flight
      finishResume();
      await flushMicrotasks();
      expect(chimesPlayed()).toBe(0);
    });
  });
});
