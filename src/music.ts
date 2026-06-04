/**
 * MusicAdapter — ALL focus-music playback lives here, mirroring AlarmAdapter:
 * the engine drives lifecycle (start/pause/resume/stop) and never touches the
 * <audio> element or the Spotify bridge directly.
 *
 * Sources (settings.musicSource, parsed by parseMusicSource):
 * - bundled: "Morning Coffee" by HoliznaCC0 (CC0 1.0 / public domain), looped.
 * - stream:  any http(s) URL, played by the same <audio> element.
 * - spotify: a track/playlist/album link; drives the local Spotify desktop
 *   app via shell.spotifyControl (macOS only). Volume slider does not apply.
 *
 * Every failure (Spotify missing/non-macOS/browser, stream URL broken) falls
 * back to the bundled track for the session — never silence.
 *
 * `shouldPlay` tracks the engine-driven intent separately from the enabled
 * setting, so toggling music in settings mid-session starts/stops playback
 * immediately and correctly.
 */
import musicUrl from './assets/focus-music.m4a';
import { spotifyControl } from './shell';

export interface MusicPort {
  /** Apply the user setting; if a session is active, start/stop immediately. */
  setEnabled(on: boolean): void;
  /** Apply the user volume (0–1) immediately. No-op while Spotify plays. */
  setVolume(v: number): void;
  /** Apply the music-source setting; if a session is active, switch live. */
  setSource(raw: string): void;
  /** Begin playback from the start (session started). */
  start(): void;
  /** Pause playback, keeping position (session paused). */
  pause(): void;
  /** Resume playback (session resumed). */
  resume(): void;
  /** Stop playback and rewind (session cancelled/completed/dismissed). */
  stop(): void;
}

export type MusicSource =
  | { kind: 'bundled' }
  | { kind: 'stream'; url: string }
  | { kind: 'spotify'; uri: string };

/**
 * Classify the musicSource setting. Spotify links/URIs → spotify (normalized
 * to the spotify:kind:id URI form); other http(s) URLs → stream; everything
 * else (including empty and unparseable input) → bundled.
 */
export function parseMusicSource(raw: string): MusicSource {
  const s = raw.trim();
  if (!s) return { kind: 'bundled' };
  if (/^spotify:(track|playlist|album):[A-Za-z0-9]+$/.test(s)) {
    return { kind: 'spotify', uri: s };
  }
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return { kind: 'bundled' };
  }
  if (url.hostname === 'open.spotify.com') {
    // Tolerates locale prefixes (/intl-fr/track/…) and query strings (?si=…).
    const m = url.pathname.match(/\/(track|playlist|album)\/([A-Za-z0-9]+)/);
    return m ? { kind: 'spotify', uri: `spotify:${m[1]}:${m[2]}` } : { kind: 'bundled' };
  }
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    return { kind: 'stream', url: s };
  }
  return { kind: 'bundled' };
}

/** Caption for the settings panel, derived from the same classification. */
export function sourceLabel(raw: string): string {
  switch (parseMusicSource(raw).kind) {
    case 'spotify':
      return 'Spotify (macOS)';
    case 'stream':
      return 'Custom audio URL';
    default:
      return 'Bundled track';
  }
}

let volume = 0.35; // overwritten from settings on boot
let audio: HTMLAudioElement | null = null;
let enabled = true;
let shouldPlay = false; // engine intent: a session is running right now
let retryArmed = false;
let source: MusicSource = { kind: 'bundled' };
let spotifyFallback = false; // Spotify play failed → bundled audio this session
let streamFailed = false; // stream URL failed to load → bundled until source changes

/** True while lifecycle calls should go to the Spotify app, not <audio>. */
function useSpotify(): boolean {
  return source.kind === 'spotify' && !spotifyFallback;
}

function audioSrc(): string {
  return source.kind === 'stream' && !streamFailed ? source.url : musicUrl;
}

function disposeAudio(): void {
  if (!audio) return;
  audio.pause();
  audio = null;
}

function getAudio(): HTMLAudioElement {
  if (!audio) {
    audio = new Audio(audioSrc());
    audio.loop = true;
    audio.volume = volume;
    audio.addEventListener('error', () => {
      // Custom stream failed to load — fall back to the bundled track.
      if (source.kind !== 'stream' || streamFailed) return;
      streamFailed = true;
      disposeAudio();
      if (shouldPlay && enabled) play();
    });
  }
  return audio;
}

function play(): void {
  getAudio()
    .play()
    .catch(() => {
      // Autoplay blocked (e.g. restoring a running timer on relaunch before
      // any user gesture) — retry once on the next interaction.
      if (retryArmed) return;
      retryArmed = true;
      const retry = () => {
        retryArmed = false;
        document.removeEventListener('pointerdown', retry);
        document.removeEventListener('keydown', retry);
        if (shouldPlay && enabled && !useSpotify()) void getAudio().play().catch(() => {});
      };
      document.addEventListener('pointerdown', retry);
      document.addEventListener('keydown', retry);
    });
}

/** Start the bundled/stream <audio> from the top. */
function startAudio(): void {
  getAudio().currentTime = 0;
  play();
}

export const MusicAdapter: MusicPort = {
  setEnabled(on: boolean) {
    enabled = on;
    if (useSpotify()) {
      // Re-issue the full play (with URI) on unmute so the right context plays
      // even if the session started muted; pause on mute.
      if (on && shouldPlay) this.start();
      else if (!on) void spotifyControl('pause');
      return;
    }
    if (on && shouldPlay) play();
    else audio?.pause();
  },
  setVolume(v: number) {
    volume = Math.max(0, Math.min(1, v));
    if (audio) audio.volume = volume;
  },
  setSource(raw: string) {
    // Silence the old source, then (if a session is active) start the new one.
    if (useSpotify()) void spotifyControl('pause');
    disposeAudio();
    source = parseMusicSource(raw);
    spotifyFallback = false;
    streamFailed = false;
    if (shouldPlay && enabled) this.start();
  },
  start() {
    shouldPlay = true;
    if (!enabled) return;
    if (source.kind === 'spotify') {
      spotifyFallback = false; // retry Spotify each session
      const uri = source.uri;
      void spotifyControl('play', uri).then((ok) => {
        if (ok || !shouldPlay || !enabled) return;
        spotifyFallback = true; // Spotify unavailable — bundled for this session
        startAudio();
      });
      return;
    }
    startAudio();
  },
  pause() {
    shouldPlay = false;
    if (useSpotify()) {
      void spotifyControl('pause');
      return;
    }
    audio?.pause();
  },
  resume() {
    shouldPlay = true;
    if (!enabled) return;
    if (useSpotify()) {
      void spotifyControl('resume').then((ok) => {
        if (ok || !shouldPlay || !enabled) return;
        spotifyFallback = true; // Spotify quit mid-session — bundled instead
        play();
      });
      return;
    }
    play();
  },
  stop() {
    shouldPlay = false;
    if (useSpotify()) void spotifyControl('pause');
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
    }
  },
};
