# Music Source Override Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Music source" text field in settings: paste a direct audio URL (streamed in-app) or a Spotify song/playlist link (drives the local Spotify desktop app on macOS) to replace the bundled focus track; empty = bundled track.

**Architecture:** `settings.ts` gains a `musicSource` string. `music.ts` keeps the single `MusicPort` but routes lifecycle calls to one of two internal backends (existing `<audio>` vs. Spotify control via a new `spotifyControl()` in `shell.ts`, backed by a `spotify_control` Rust command running `osascript`). Every failure path falls back to the bundled track — never silence. Spec: `docs/superpowers/specs/2026-06-04-music-source-override-design.md`.

**Tech Stack:** Vanilla TypeScript (strict tsc), Tauri 2 (one custom Rust command, macOS-only via `cfg`), no UI framework.

**Testing note:** This repo has no test framework — per project CLAUDE.md, strict `tsc` (`npm run build`) is the only automated gate. Each task ends with `npm run build` (plus `cargo check` for the Rust task) and a commit; Task 6 is the manual verification pass from the spec. Do not add a test framework.

---

### Task 1: `musicSource` setting

**Files:**
- Modify: `src/settings.ts`

- [ ] **Step 1: Add the field to the interface, defaults, and load/save**

In `src/settings.ts`, add to the `Settings` interface (after `defaultPresetMin`):

```ts
  /** Music override: '' = bundled, http(s) URL = stream, Spotify link/URI = local app. */
  musicSource: string;
```

Update `DEFAULTS`:

```ts
const DEFAULTS: Settings = {
  music: true,
  volume: 0.35,
  defaultPresetMin: null,
  musicSource: '',
};
```

In `loadSettings()`, add to the returned object (after `defaultPresetMin`):

```ts
      musicSource:
        typeof saved.musicSource === 'string' ? saved.musicSource.trim() : '',
```

`saveSettings` needs no change (it serializes the whole object).

- [ ] **Step 2: Type-check**

Run: `npm run build`
Expected: PASS (no errors; nothing consumes the field yet, which is fine — tsc doesn't flag unused interface fields).

- [ ] **Step 3: Commit**

```bash
git add src/settings.ts
git commit -m "Add musicSource setting (default '': bundled track)"
```

---

### Task 2: `spotifyControl()` in shell.ts

**Files:**
- Modify: `src/shell.ts`

- [ ] **Step 1: Add the invoke wrapper**

In `src/shell.ts`, add the import at the top (alongside the existing window import):

```ts
import { invoke } from '@tauri-apps/api/core';
```

Append at the end of the file:

```ts
/**
 * Drive the local Spotify desktop app (macOS only) via the `spotify_control`
 * Rust command. Resolves false outside Tauri or on any command error so
 * music.ts can fall back to the bundled track.
 */
export async function spotifyControl(
  action: 'play' | 'pause' | 'resume',
  uri?: string,
): Promise<boolean> {
  if (!isTauri) return false;
  try {
    await invoke('spotify_control', { action, uri });
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 2: Type-check**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/shell.ts
git commit -m "Add spotifyControl shell wrapper for the spotify_control command"
```

---

### Task 3: Source parsing + dual-backend music.ts

**Files:**
- Modify: `src/music.ts` (full rewrite below)

- [ ] **Step 1: Replace `src/music.ts` with the dual-backend version**

Full new content of `src/music.ts`:

```ts
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
```

- [ ] **Step 2: Type-check**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Sanity-check the engine invariant**

Read `src/engine.ts` and confirm `complete()` still calls `music.stop()` before `alarm.start()` (no engine change is needed — `stop()` now also pauses Spotify, so the chime never overlaps playback).

- [ ] **Step 4: Commit**

```bash
git add src/music.ts
git commit -m "Route music lifecycle to audio or local Spotify per musicSource"
```

---

### Task 4: `spotify_control` Rust command + Info.plist

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Create: `src-tauri/Info.plist`

- [ ] **Step 1: Add the command to `src-tauri/src/lib.rs`**

Full new content of `src-tauri/src/lib.rs`:

```rust
/// Drive the local Spotify desktop app via AppleScript (macOS only).
/// Other platforms return Err, which the frontend treats as "fall back to
/// the bundled track". The URI is validated to spotify:kind:base62id before
/// interpolation so no arbitrary text reaches osascript.
#[tauri::command]
fn spotify_control(action: String, uri: Option<String>) -> Result<(), String> {
  #[cfg(target_os = "macos")]
  {
    let script = match action.as_str() {
      "play" => {
        let uri = uri.ok_or("missing uri")?;
        let valid = uri.strip_prefix("spotify:").is_some_and(|rest| {
          let mut parts = rest.splitn(2, ':');
          matches!(parts.next(), Some("track" | "playlist" | "album"))
            && parts
              .next()
              .is_some_and(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric()))
        });
        if !valid {
          return Err("invalid spotify uri".into());
        }
        // `set repeating to true` keeps a single track looping for the session.
        format!(
          "tell application \"Spotify\"\nplay track \"{uri}\"\nset repeating to true\nend tell"
        )
      }
      // Guarded so pause/resume never *launch* Spotify, only control it.
      "pause" => {
        "if application \"Spotify\" is running then tell application \"Spotify\" to pause".into()
      }
      "resume" => {
        "if application \"Spotify\" is running then tell application \"Spotify\" to play".into()
      }
      _ => return Err("unknown action".into()),
    };
    let status = std::process::Command::new("osascript")
      .arg("-e")
      .arg(&script)
      .status()
      .map_err(|e| e.to_string())?;
    if status.success() {
      Ok(())
    } else {
      Err("osascript failed".into())
    }
  }
  #[cfg(not(target_os = "macos"))]
  {
    let _ = (action, uri);
    Err("spotify control is macos-only".into())
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_notification::init())
    .invoke_handler(tauri::generate_handler![spotify_control])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
```

No capability entry is needed: app-defined commands (unlike plugin commands) are invokable from the app's own windows by default in Tauri 2.

- [ ] **Step 2: Create `src-tauri/Info.plist`**

Tauri merges this into the macOS bundle; `NSAppleEventsUsageDescription` is required for the automation permission prompt ("Stint wants to control Spotify") to appear in signed release builds.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>NSAppleEventsUsageDescription</key>
  <string>Stint controls the Spotify app to play your focus music while the timer runs.</string>
</dict>
</plist>
```

- [ ] **Step 3: Compile-check the Rust side**

Run: `source "$HOME/.cargo/env" 2>/dev/null; cargo check --manifest-path src-tauri/Cargo.toml`
Expected: `Finished` with no errors (warnings about the unused command are not expected — it's registered in the handler).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/Info.plist
git commit -m "Add spotify_control command (osascript, macOS) + automation usage string"
```

---

### Task 5: Settings panel UI + wiring

**Files:**
- Modify: `index.html` (settings panel, after the Volume row ~line 61)
- Modify: `src/styles.css` (settings panel section, after `.volume-slider` rules ~line 215)
- Modify: `src/main.ts` (boot block ~line 85, settings panel section ~lines 161–236)

- [ ] **Step 1: Add the settings row to `index.html`**

Insert between the Volume row (`</div>` closing the `music-volume` row) and the "Space starts" row:

```html
        <div class="settings-row column">
          <span class="settings-label">Music source</span>
          <input class="source-input" id="music-source" type="text"
                 placeholder="Paste an audio URL or Spotify link"
                 aria-label="Music source" spellcheck="false" autocomplete="off" />
          <span class="settings-hint" id="music-source-hint">Bundled track</span>
        </div>
```

- [ ] **Step 2: Add styles to `src/styles.css`**

Insert after the `.volume-slider::-moz-range-thumb` rule (before the "default-preset chips" comment):

```css
/* music source input + detected-mode hint */
.source-input {
  width: 100%; box-sizing: border-box; padding: 7px 10px;
  background: var(--surface3); border: 1px solid var(--outline);
  border-radius: 8px; color: var(--text);
  font: inherit; font-size: 12px; outline: none;
}
.source-input:focus { border-color: var(--accent); }
.source-input::placeholder { color: var(--text-dim); }
.settings-hint { font-size: 11px; color: var(--text-dim); }
```

- [ ] **Step 3: Wire it in `src/main.ts`**

Import `sourceLabel` — change the music import (line 11) to:

```ts
import { MusicAdapter, sourceLabel } from './music';
```

In the boot block (after `MusicAdapter.setVolume(settings.volume);`, line 87 — must stay before `engine.restore()` so a relaunch-restored session plays the right source):

```ts
MusicAdapter.setSource(settings.musicSource);
```

In the settings-panel DOM refs (after `volumeSlider`, ~line 165):

```ts
const sourceInput = $<HTMLInputElement>('music-source');
const sourceHint = $('music-source-hint');
```

In `renderSettings()` (after the `volumeSlider.value = …` line):

```ts
  sourceInput.value = settings.musicSource;
  sourceHint.textContent = sourceLabel(settings.musicSource);
```

After the `volumeSlider.addEventListener('input', …)` block:

```ts
// Hint tracks the detected mode live while typing; the source itself applies
// on change (Enter/blur) so playback doesn't restart on every keystroke.
sourceInput.addEventListener('input', () => {
  sourceHint.textContent = sourceLabel(sourceInput.value);
});
sourceInput.addEventListener('change', () => {
  settings.musicSource = sourceInput.value.trim();
  saveSettings(settings);
  MusicAdapter.setSource(settings.musicSource);
  renderSettings();
});
```

(No keyboard-shortcut changes needed: while the panel is open, `handleKeydown` already gives the panel the keyboard, so typing spaces in the input works; Esc closes the panel, which blurs the input and fires `change`.)

- [ ] **Step 4: Type-check + build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add index.html src/styles.css src/main.ts
git commit -m "Add Music source field to settings (audio URL / Spotify link)"
```

---

### Task 6: Manual verification (spec checklist)

**Files:** none (verification only)

- [ ] **Step 1: Browser pass (`npm run dev`, open localhost:5173)**

- Empty field: timer start plays the bundled track; caption reads "Bundled track".
- Paste any reachable direct mp3/m4a URL: caption flips to "Custom audio URL" while typing; press Enter; start a timer → the URL streams and loops; volume slider works.
- Paste a garbage URL (`https://example.com/nope.mp3`): start a timer → falls back to the bundled track (no silence).
- Paste a Spotify link (`https://open.spotify.com/track/…`): caption reads "Spotify (macOS)"; start a timer → bundled track plays (browser has no Tauri → fallback).
- Reload the page: the field and caption persist.

- [ ] **Step 2: Native pass (`npm run tauri dev`, macOS, Spotify installed)**

- Paste a Spotify track or playlist link; start a timer → Spotify plays it (first run shows the macOS automation prompt — accept it). Repeat is enabled.
- Pause/resume the timer → Spotify pauses/resumes. Cancel → Spotify pauses.
- Let the timer complete → Spotify pauses, then the chime rings (never overlapping).
- Mute button (chrome) while running → Spotify pauses; unmute → playback returns.
- Volume slider while Spotify plays → Spotify volume unaffected (per spec).
- Quit Spotify mid-session, pause+resume the timer → bundled track takes over.
- Clear the field, start a timer → bundled track again.

- [ ] **Step 3: Fix anything that fails, re-verify, then commit any fixes**

```bash
git add -A
git commit -m "Fix issues found in music-source verification"
```

(Skip the commit if nothing needed fixing.)
