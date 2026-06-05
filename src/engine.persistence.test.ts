/**
 * Relaunch behavior: a fresh TimerEngine restoring localStorage `stint.timer`,
 * exactly like main.ts does on boot. Covers the three relaunch rules:
 *   - a still-running timer reconstructs from its absolute endTime,
 *   - one that expired while away resets to idle WITHOUT alarming,
 *   - an undismissed done state reopens as idle (no auto-alarm).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlarmPort } from './alarm';
import type { MusicPort } from './music';
import { TimerEngine } from './engine';

function makePorts() {
  const calls: string[] = [];
  const alarm: AlarmPort = {
    unlock: () => calls.push('alarm.unlock'),
    start: () => calls.push('alarm.start'),
    stop: () => calls.push('alarm.stop'),
  };
  const music: MusicPort = {
    setEnabled: () => calls.push('music.setEnabled'),
    setVolume: () => calls.push('music.setVolume'),
    setSource: () => calls.push('music.setSource'),
    start: () => calls.push('music.start'),
    pause: () => calls.push('music.pause'),
    resume: () => calls.push('music.resume'),
    stop: () => calls.push('music.stop'),
  };
  return { calls, alarm, music };
}

/** Boot a second engine from whatever the first one persisted. */
function relaunch() {
  const ports = makePorts();
  const engine = new TimerEngine(ports.alarm, ports.music, () => {});
  engine.restore();
  return { engine, ...ports };
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('restore on relaunch', () => {
  it('reconstructs a still-running timer from endTime and restarts music', () => {
    const first = makePorts();
    const e1 = new TimerEngine(first.alarm, first.music, () => {});
    e1.startWith(600);
    vi.advanceTimersByTime(100_000); // 100s elapse before "quit"

    const { engine, calls } = relaunch();
    expect(engine.mode).toBe('running');
    expect(engine.total).toBe(600);
    expect(engine.remaining).toBeCloseTo(500, 0);
    expect(calls).toContain('music.start');
    expect(calls).not.toContain('alarm.start');

    // …and it still completes at the original deadline.
    vi.advanceTimersByTime(501_000);
    expect(engine.mode).toBe('done');
  });

  it('a timer that expired while away resets to idle WITHOUT alarming', () => {
    const first = makePorts();
    const e1 = new TimerEngine(first.alarm, first.music, () => {});
    e1.startWith(60);
    // Simulate quit: drop the engine, let the deadline pass unobserved.
    vi.setSystemTime(Date.now() + 120_000);

    const { engine, calls } = relaunch();
    expect(engine.mode).toBe('idle');
    expect(engine.remaining).toBe(60);
    expect(calls).not.toContain('alarm.start');
    expect(calls).not.toContain('music.start');
  });

  it('an undismissed done state reopens as idle (no auto-alarm)', () => {
    const first = makePorts();
    const e1 = new TimerEngine(first.alarm, first.music, () => {});
    e1.startWith(5);
    vi.advanceTimersByTime(6_000);
    expect(e1.mode).toBe('done');

    const { engine, calls } = relaunch();
    expect(engine.mode).toBe('idle');
    expect(engine.remaining).toBe(5);
    expect(calls).not.toContain('alarm.start');
  });

  it('a paused timer restores paused with its frozen remaining', () => {
    const first = makePorts();
    const e1 = new TimerEngine(first.alarm, first.music, () => {});
    e1.startWith(600);
    vi.advanceTimersByTime(100_000);
    e1.pause();

    const { engine, calls } = relaunch();
    expect(engine.mode).toBe('paused');
    expect(engine.remaining).toBeCloseTo(500, 0);
    expect(calls).not.toContain('music.start');
  });

  it('corrupted persisted state falls back to a clean default idle', () => {
    localStorage.setItem('stint.timer', '{not json');
    const { engine } = relaunch();
    expect(engine.mode).toBe('idle');
    expect(engine.remaining).toBe(25 * 60);
  });

  it('no persisted state boots the 25-minute default', () => {
    const { engine } = relaunch();
    expect(engine.mode).toBe('idle');
    expect(engine.total).toBe(25 * 60);
  });
});
