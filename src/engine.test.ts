/**
 * Functional tests for TimerEngine — the state machine and its alarm/music
 * ordering invariants, driven entirely by fake timers (Date.now, setTimeout,
 * requestAnimationFrame are all virtual; no real waiting).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlarmPort } from './alarm';
import type { MusicPort } from './music';
import { TimerEngine } from './engine';

/** Records every port call in order, so tests can assert sequencing. */
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

function makeEngine() {
  const ports = makePorts();
  const engine = new TimerEngine(ports.alarm, ports.music, () => {}, (on) =>
    ports.calls.push(on ? 'keep:on' : 'keep:off'),
  );
  return { engine, ...ports };
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('start / countdown / complete', () => {
  it('startWith enters running with the requested duration and starts music', () => {
    const { engine, calls } = makeEngine();
    engine.startWith(60);
    expect(engine.mode).toBe('running');
    expect(engine.total).toBe(60);
    expect(engine.remaining).toBe(60);
    expect(calls).toContain('music.start');
  });

  it('startWith silences any ringing alarm BEFORE unlocking/starting (done-state restart invariant)', () => {
    const { engine, calls } = makeEngine();
    engine.startWith(60);
    expect(calls.indexOf('alarm.stop')).toBeLessThan(calls.indexOf('alarm.unlock'));
    expect(calls.indexOf('alarm.stop')).toBeLessThan(calls.indexOf('music.start'));
  });

  it('counts down from the absolute end timestamp', () => {
    const { engine } = makeEngine();
    engine.startWith(60);
    vi.advanceTimersByTime(10_000);
    expect(engine.remaining).toBeCloseTo(50, 0);
    expect(engine.mode).toBe('running');
  });

  it('completes at the end: mode done, music stops BEFORE alarm starts', () => {
    const { engine, calls } = makeEngine();
    engine.startWith(5);
    calls.length = 0;
    vi.advanceTimersByTime(6_000);
    expect(engine.mode).toBe('done');
    expect(engine.remaining).toBe(0);
    expect(calls).toContain('music.stop');
    expect(calls).toContain('alarm.start');
    expect(calls.indexOf('music.stop')).toBeLessThan(calls.indexOf('alarm.start'));
  });

  it('fires completion exactly once', () => {
    const { engine, calls } = makeEngine();
    engine.startWith(5);
    vi.advanceTimersByTime(60_000);
    expect(calls.filter((c) => c === 'alarm.start')).toHaveLength(1);
  });
});

describe('pause / resume', () => {
  it('pause freezes remaining and pauses music', () => {
    const { engine, calls } = makeEngine();
    engine.startWith(60);
    vi.advanceTimersByTime(20_000);
    engine.pause();
    expect(engine.mode).toBe('paused');
    expect(calls).toContain('music.pause');
    const frozen = engine.remaining;
    vi.advanceTimersByTime(30_000);
    expect(engine.remaining).toBe(frozen);
    expect(engine.mode).toBe('paused');
  });

  it('resume recomputes endTime so the session still gets its full remaining time', () => {
    const { engine, calls } = makeEngine();
    engine.startWith(60);
    vi.advanceTimersByTime(20_000);
    engine.pause();
    vi.advanceTimersByTime(120_000); // long break — must not eat into the timer
    engine.resume();
    expect(engine.mode).toBe('running');
    expect(calls).toContain('music.resume');
    vi.advanceTimersByTime(30_000);
    expect(engine.mode).toBe('running'); // ~10s still left
    vi.advanceTimersByTime(11_000);
    expect(engine.mode).toBe('done');
  });
});

describe('cancel / restart / dismiss', () => {
  it('cancel returns to idle, resets remaining, and stops alarm + music', () => {
    const { engine, calls } = makeEngine();
    engine.startWith(60);
    vi.advanceTimersByTime(10_000);
    calls.length = 0;
    engine.cancel();
    expect(engine.mode).toBe('idle');
    expect(engine.remaining).toBe(60);
    expect(calls).toContain('alarm.stop');
    expect(calls).toContain('music.stop');
    vi.advanceTimersByTime(120_000);
    expect(engine.mode).toBe('idle'); // no zombie completion
  });

  it('restart from the ringing done state silences the chime and runs again', () => {
    const { engine, calls } = makeEngine();
    engine.startWith(5);
    vi.advanceTimersByTime(6_000);
    expect(engine.mode).toBe('done');
    calls.length = 0;
    engine.restart();
    expect(engine.mode).toBe('running');
    expect(engine.remaining).toBe(5);
    expect(calls[0]).toBe('alarm.stop');
  });

  it('stopSound dismisses the done state back to a clean idle', () => {
    const { engine, calls } = makeEngine();
    engine.startWith(5);
    vi.advanceTimersByTime(6_000);
    calls.length = 0;
    engine.stopSound();
    expect(engine.mode).toBe('idle');
    expect(engine.remaining).toBe(5);
    expect(calls).toContain('alarm.stop');
    expect(calls).toContain('music.stop');
  });
});

describe('keep-awake (prevents background App Nap)', () => {
  it('acquires keep-awake when a session starts', () => {
    const { engine, calls } = makeEngine();
    engine.startWith(60);
    expect(calls).toContain('keep:on');
  });

  it('stays awake through completion so the background chime can play', () => {
    const { engine, calls } = makeEngine();
    engine.startWith(5);
    calls.length = 0;
    vi.advanceTimersByTime(6_000);
    expect(engine.mode).toBe('done');
    // Must NOT release on complete: the 10s chime needs the process un-napped.
    expect(calls).not.toContain('keep:off');
  });

  it('releases keep-awake when the done state is dismissed', () => {
    const { engine, calls } = makeEngine();
    engine.startWith(5);
    vi.advanceTimersByTime(6_000);
    calls.length = 0;
    engine.stopSound();
    expect(calls).toContain('keep:off');
  });

  it('releases on pause and re-acquires on resume', () => {
    const { engine, calls } = makeEngine();
    engine.startWith(60);
    calls.length = 0;
    engine.pause();
    expect(calls).toContain('keep:off');
    calls.length = 0;
    engine.resume();
    expect(calls).toContain('keep:on');
  });

  it('releases keep-awake on cancel', () => {
    const { engine, calls } = makeEngine();
    engine.startWith(60);
    calls.length = 0;
    engine.cancel();
    expect(calls).toContain('keep:off');
  });

  it('re-acquires keep-awake when restoring a still-running session', () => {
    const first = makeEngine();
    first.engine.startWith(600);
    vi.advanceTimersByTime(10_000);

    const ports = makePorts();
    const engine = new TimerEngine(ports.alarm, ports.music, () => {}, (on) =>
      ports.calls.push(on ? 'keep:on' : 'keep:off'),
    );
    engine.restore();
    expect(engine.mode).toBe('running');
    expect(ports.calls).toContain('keep:on');
  });
});
