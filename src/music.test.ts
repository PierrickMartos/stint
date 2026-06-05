/**
 * MusicAdapter — source classification, lifecycle routing (<audio> vs the
 * Spotify bridge), the bundled-track fallback, and the generation counter
 * that keeps stale async Spotify results from overriding a newer source.
 *
 * spotifyControl is mocked with manually-resolved deferreds so tests control
 * exactly when the async result lands. Module state resets via resetModules.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MusicPort } from './music';

// ---- spotifyControl mock: a queue of manually-resolved deferreds ----------
interface SpotifyCall {
  action: string;
  uri?: string;
  resolve: (ok: boolean) => void;
}
let spotifyCalls: SpotifyCall[] = [];

function lastSpotifyCall(): SpotifyCall {
  return spotifyCalls[spotifyCalls.length - 1];
}

vi.mock('./shell', () => ({
  isTauri: false,
  spotifyControl: (action: string, uri?: string) =>
    new Promise<boolean>((resolve) => {
      spotifyCalls.push({ action, uri, resolve });
    }),
}));

// ---- fake <audio> ----------------------------------------------------------
class FakeAudio {
  static instances: FakeAudio[] = [];
  src: string;
  loop = false;
  volume = 1;
  currentTime = 0;
  paused = true;
  playCount = 0;
  private listeners: Record<string, (() => void)[]> = {};
  constructor(src: string) {
    this.src = src;
    FakeAudio.instances.push(this);
  }
  play(): Promise<void> {
    this.paused = false;
    this.playCount++;
    return Promise.resolve();
  }
  pause(): void {
    this.paused = true;
  }
  addEventListener(type: string, fn: () => void): void {
    (this.listeners[type] ??= []).push(fn);
  }
  removeEventListener(): void {}
  fireError(): void {
    for (const fn of this.listeners['error'] ?? []) fn();
  }
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

let music: MusicPort;
let parseMusicSource: typeof import('./music').parseMusicSource;

beforeEach(async () => {
  spotifyCalls = [];
  FakeAudio.instances = [];
  vi.stubGlobal('Audio', FakeAudio);
  vi.resetModules();
  const mod = await import('./music');
  music = mod.MusicAdapter;
  parseMusicSource = mod.parseMusicSource;
});

afterEach(() => {
  music.stop();
  vi.unstubAllGlobals();
});

describe('parseMusicSource', () => {
  it('classifies empty and garbage input as bundled', () => {
    expect(parseMusicSource('')).toEqual({ kind: 'bundled' });
    expect(parseMusicSource('   ')).toEqual({ kind: 'bundled' });
    expect(parseMusicSource('not a url')).toEqual({ kind: 'bundled' });
    expect(parseMusicSource('ftp://host/file.mp3')).toEqual({ kind: 'bundled' });
  });

  it('classifies http(s) URLs as stream', () => {
    expect(parseMusicSource('https://example.com/lofi.mp3')).toEqual({
      kind: 'stream',
      url: 'https://example.com/lofi.mp3',
    });
  });

  it('normalizes Spotify links and URIs to spotify:kind:id', () => {
    expect(parseMusicSource('spotify:track:4uLU6hMCjMI75M1A2tKUQC')).toEqual({
      kind: 'spotify',
      uri: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC',
    });
    expect(
      parseMusicSource('https://open.spotify.com/intl-fr/playlist/37i9dQZF1DX8Uebhn9wzrS?si=abc'),
    ).toEqual({ kind: 'spotify', uri: 'spotify:playlist:37i9dQZF1DX8Uebhn9wzrS' });
    // An open.spotify.com URL that is not a track/playlist/album → bundled.
    expect(parseMusicSource('https://open.spotify.com/artist/xyz')).toEqual({ kind: 'bundled' });
  });
});

describe('bundled lifecycle', () => {
  it('start plays the bundled track from the top; pause/resume/stop route to <audio>', async () => {
    music.start();
    await flush();
    expect(FakeAudio.instances).toHaveLength(1);
    const a = FakeAudio.instances[0];
    expect(a.loop).toBe(true);
    expect(a.paused).toBe(false);

    music.pause();
    expect(a.paused).toBe(true);

    music.resume();
    await flush();
    expect(a.paused).toBe(false);

    a.currentTime = 42;
    music.stop();
    expect(a.paused).toBe(true);
    expect(a.currentTime).toBe(0); // stop rewinds
  });

  it('setEnabled(false) mid-session silences; setEnabled(true) brings music back', async () => {
    music.start();
    await flush();
    const a = FakeAudio.instances[0];
    music.setEnabled(false);
    expect(a.paused).toBe(true);
    music.setEnabled(true);
    await flush();
    expect(a.paused).toBe(false);
  });

  it('setVolume clamps to 0–1 and applies live', async () => {
    music.start();
    await flush();
    music.setVolume(1.7);
    expect(FakeAudio.instances[0].volume).toBe(1);
    music.setVolume(-3);
    expect(FakeAudio.instances[0].volume).toBe(0);
  });
});

describe('spotify routing', () => {
  it('start with a Spotify source drives the bridge, not <audio>', async () => {
    music.setSource('spotify:track:abc123');
    music.start();
    expect(lastSpotifyCall()).toMatchObject({ action: 'play', uri: 'spotify:track:abc123' });
    lastSpotifyCall().resolve(true);
    await flush();
    expect(FakeAudio.instances).toHaveLength(0); // never touched <audio>

    music.pause();
    expect(lastSpotifyCall().action).toBe('pause');
  });

  it('falls back to the bundled track when Spotify is unavailable', async () => {
    music.setSource('spotify:track:abc123');
    music.start();
    lastSpotifyCall().resolve(false); // Spotify missing / not macOS
    await flush();
    expect(FakeAudio.instances).toHaveLength(1);
    expect(FakeAudio.instances[0].paused).toBe(false); // never silence
  });

  it('a stale in-flight Spotify result cannot override a newer source (generation guard)', async () => {
    music.setSource('spotify:track:abc123');
    music.start();
    const stale = lastSpotifyCall();

    music.setSource(''); // user switches back to bundled while play() is in flight
    await flush();
    const bundled = FakeAudio.instances[0];
    expect(bundled.paused).toBe(false);
    expect(bundled.playCount).toBe(1);

    stale.resolve(false); // old call finally fails…
    await flush();
    // …but must NOT restart the bundled track or flip the fallback flag.
    expect(bundled.playCount).toBe(1);
    expect(bundled.currentTime).toBe(0);
    expect(FakeAudio.instances).toHaveLength(1);
  });

  it('stream URL that fails to load falls back to the bundled track', async () => {
    music.setSource('https://example.com/dead.mp3');
    music.start();
    await flush();
    const stream = FakeAudio.instances[0];
    expect(stream.src).toBe('https://example.com/dead.mp3');

    stream.fireError();
    await flush();
    expect(FakeAudio.instances).toHaveLength(2);
    const fallback = FakeAudio.instances[1];
    expect(fallback.src).not.toBe('https://example.com/dead.mp3');
    expect(fallback.paused).toBe(false);
  });
});
