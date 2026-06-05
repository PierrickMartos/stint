# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Stint — a single-purpose desktop focus timer (Tauri 2 + Vite + vanilla TypeScript, no UI framework). The design is fixed: Direction B "Soft premium" from a Claude Design handoff — soft indigo `#8C9BFF` on near-black, a depleting progress ring, frameless 440×560 window with a 376×116 compact mode. `Timer.html` at the repo root is the original verified single-file implementation the app was ported from; treat it as the design/behavior reference, not dead code.

## Commands

```bash
npm run dev          # browser preview at localhost:5173 (no Rust needed)
npm run tauri dev    # the real native app (first Rust compile takes minutes)
npm run build        # tsc type-check + vite build
npm run test         # Vitest functional tests (src/*.test.ts, happy-dom, fake timers)
npm run tauri build  # release bundle → src-tauri/target/release/bundle/
```

There is no linter; the gates are strict `tsc` and the Vitest suite — `.github/workflows/ci.yml` runs both on every push/PR (no Rust needed). Tests live next to their modules (`src/*.test.ts`); `alarm.ts`/`music.ts` keep module-level state, so their suites isolate via `vi.resetModules()` + dynamic import, and `music.test.ts` mocks `./shell` and the global `Audio`. Rust toolchain comes from rustup (`source "$HOME/.cargo/env"` if cargo isn't on PATH).

**Release:** bump `version` in `src-tauri/tauri.conf.json`, then `git tag vX.Y.Z && git push origin vX.Y.Z`. GitHub Actions (`.github/workflows/release.yml`) builds macOS (universal) + Windows + Linux and publishes all assets to one GitHub Release. `scripts/install.sh` and the README point at the *latest* release, so never delete releases casually.

## Architecture

**Dual presentation, one codebase.** An inline `<head>` script adds `html.in-tauri` when running inside Tauri. In a browser (`npm run dev`), the page shows the design-canvas presentation: dark backdrop + bloom + helper line around a CSS-sized floating "window" div. In Tauri, that chrome collapses and the **native window is the panel** — transparent, undecorated (`macOSPrivateApi: true` + the `macos-private-api` cargo feature are required for this on macOS). CSS box-shadow is disabled in Tauri mode because the OS draws the shadow.

**Strict separation in `src/`:**
- `engine.ts` — `TimerEngine`, the whole state machine (`idle | running | paused | done`). Countdown derives from an absolute `endTime` timestamp (never decrements a counter); a `setTimeout` fallback fires completion when rAF is throttled in hidden windows. Persists lifecycle changes (not ticks) to localStorage `stint.timer`; on relaunch a running timer reconstructs from `endTime`, and one that expired while away resets *without* alarming.
- `alarm.ts` — ALL completion side-effects behind one `AlarmPort` (WebAudio chime loop + native notification). The engine never touches audio/notification APIs.
- `music.ts` — ALL focus-music playback behind one `MusicPort`, routed to one of two backends by `settings.musicSource` (`parseMusicSource`: empty → bundled CC0 track, http(s) URL → same `<audio>` element streams it, Spotify link/URI → the local Spotify desktop app via `shell.spotifyControl`). The engine drives `start/pause/resume/stop` from its lifecycle methods only. `setEnabled`/`setVolume`/`setSource` are the settings-facing side; internal `shouldPlay` tracks engine intent so toggling music mid-session behaves. Every failure (Spotify missing/non-macOS, broken stream URL) falls back to the bundled track — never silence; `spotifyGen` orphans stale async results, `spotifyStarted` makes unmute *resume* Spotify rather than restart the playlist.
- `settings.ts` — typed load/save of localStorage `stint.settings` (`music`, `volume`, `musicSource`, `defaultPresetMin`; `defaultPresetMin: null` = Space starts the last-used duration, `musicSource: ''` = bundled track).
- `shell.ts` — ALL Tauri APIs (`isTauri`, native window resize for compact mode, drag regions, `spotifyControl` → the `spotify_control` Rust command). Nothing else imports `@tauri-apps/*`.
- `main.ts` — DOM wiring, the settings panel (gear → overlay, expanded layout only), and one explicit `render()` function.

**CSS is the state renderer.** Both layouts (expanded `#app`, compact `#app-compact`) exist in the DOM simultaneously; `render()` sets `data-mode` on both and CSS attribute selectors do the rest (control-group visibility, label/icon swaps, accent wash, ring opacity). When adding state-dependent UI, follow this pattern rather than toggling styles from JS.

**Engine ↔ alarm invariant:** `startWith()` must call `alarm.stop()` first — the original React prototype cleaned up the chime interval implicitly via effect cleanup; the vanilla port must do it explicitly or starting a preset from the ringing done-state leaks the chime forever. Similarly `complete()` calls `music.stop()` *before* `alarm.start()` so the track never plays under the chime.

**Focus music asset:** `src/assets/focus-music.m4a` is "Morning Coffee" by HoliznaCC0 (CC0 1.0, from Free Music Archive), re-encoded from the 320 kbps source mp3 to 128 kbps AAC via `afconvert -f m4af -d aac -b 128000`. The mute buttons (expanded chrome + compact bar) and the settings-panel switch are all views of the single `settings.music` flag.

**Spotify control (macOS):** the `spotify_control` Rust command (`src-tauri/src/lib.rs`) shells out to `osascript`; the URI is re-validated in Rust (`spotify:track|playlist|album:base62id` only) before interpolation so nothing user-controlled reaches AppleScript. It must stay `async` — sync Tauri commands run on the main thread, and a cold Spotify launch takes seconds. `pause`/`resume` are guarded with `if application "Spotify" is running` so they never launch the app. Other platforms return `Err`, which the frontend treats as fall-back-to-bundled. App-defined commands need no capabilities entry (only plugin commands do).

## Gotchas

- **Drag regions:** Tauri's built-in `data-tauri-drag-region` handler fails silently when the mousedown target is a child of the attributed element. `shell.ts#wireDragRegions()` does explicit `startDragging()` with `closest()` instead — keep using it. Requires `core:window:allow-start-dragging` (see `src-tauri/capabilities/default.json`; `setSize` and notifications also need their entries there).
- **Local DMG builds fail** with hdiutil "Resource temporarily unavailable" on this machine (the styled-DMG script needs Finder automation). CI is unaffected (`CI=true` makes Tauri skip the styling). Locally, build a plain DMG with `hdiutil create -srcfolder` if needed.
- **App icon:** `src-tauri/icons/icon-source.svg` is the source of truth (the "Concentric" mark; 1024 canvas with artwork at 824 = macOS icon grid). To regenerate: rasterize to 1024px PNG, then `npx tauri icon <png>`. There's no SVG rasterizer CLI installed — previous regeneration used Chrome canvas.
- Keyboard shortcuts (Space/Esc) are keydown handlers on the *focused* app container; any flow that changes which layout is visible must move focus to it (see `setCompact`), or shortcuts go dead. While the settings panel is open, `handleKeydown` gives the panel the keyboard (Esc closes it instead of cancelling the timer; Space falls through to the focused control) — keep new shortcuts behind that guard.
- **Autoplay on relaunch-restore:** restoring a running timer calls `music.start()` before any user gesture; `play()` can be rejected by webview autoplay policy. `music.ts` retries once on the next pointerdown/keydown — don't "fix" the rejection by removing the catch.
- **`src-tauri/Info.plist` merges only in `tauri build`**, not `tauri dev` — so the custom `NSAppleEventsUsageDescription` ("Stint controls the Spotify app…") automation prompt appears only in release builds; dev shows a generic prompt attributed to the terminal. Don't chase that as a bug.
- Fonts (Roboto + Material Symbols) load from Google Fonts CDN with system fallbacks — offline first-launch degrades to system fonts. Vendoring them is a known open task.
