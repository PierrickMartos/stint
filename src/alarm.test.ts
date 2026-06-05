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

class FakeAudioContext {
  state = 'running';
  currentTime = 0;
  destination = {};
  createOscillator() {
    oscillatorsCreated++;
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
});
