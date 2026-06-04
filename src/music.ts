/**
 * MusicAdapter — ALL focus-music playback lives here, mirroring AlarmAdapter:
 * the engine drives lifecycle (start/pause/resume/stop) and never touches the
 * <audio> element directly.
 *
 * Track: "Morning Coffee" by HoliznaCC0 (CC0 1.0 / public domain), bundled
 * and looped at low volume while the timer runs.
 *
 * `shouldPlay` tracks the engine-driven intent separately from the enabled
 * setting, so toggling music in settings mid-session starts/stops playback
 * immediately and correctly.
 */
import musicUrl from './assets/focus-music.m4a';

export interface MusicPort {
  /** Apply the user setting; if a session is active, start/stop immediately. */
  setEnabled(on: boolean): void;
  /** Apply the user volume (0–1) immediately. */
  setVolume(v: number): void;
  /** Begin playback from the start (session started). */
  start(): void;
  /** Pause playback, keeping position (session paused). */
  pause(): void;
  /** Resume playback (session resumed). */
  resume(): void;
  /** Stop playback and rewind (session cancelled/completed/dismissed). */
  stop(): void;
}

let volume = 0.35; // overwritten from settings on boot
let audio: HTMLAudioElement | null = null;
let enabled = true;
let shouldPlay = false; // engine intent: a session is running right now
let retryArmed = false;

function getAudio(): HTMLAudioElement {
  if (!audio) {
    audio = new Audio(musicUrl);
    audio.loop = true;
    audio.volume = volume;
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
        if (shouldPlay && enabled) void getAudio().play().catch(() => {});
      };
      document.addEventListener('pointerdown', retry);
      document.addEventListener('keydown', retry);
    });
}

export const MusicAdapter: MusicPort = {
  setEnabled(on: boolean) {
    enabled = on;
    if (on && shouldPlay) play();
    else audio?.pause();
  },
  setVolume(v: number) {
    volume = Math.max(0, Math.min(1, v));
    if (audio) audio.volume = volume;
  },
  start() {
    shouldPlay = true;
    if (!enabled) return;
    getAudio().currentTime = 0;
    play();
  },
  pause() {
    shouldPlay = false;
    if (audio) audio.pause();
  },
  resume() {
    shouldPlay = true;
    if (enabled) play();
  },
  stop() {
    shouldPlay = false;
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
    }
  },
};
