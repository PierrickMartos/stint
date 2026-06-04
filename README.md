<h1 align="center">Stint</h1>

<h3 align="center">A calm, single-purpose focus timer for macOS. One click to start, a quiet countdown while you work, a gentle chime when time's up. Not a Pomodoro suite, not a task manager — just a timer that respects your attention.</h3>

<p align="center">
  <a href="https://github.com/PierrickMartos/stint/releases/latest"><img src="https://img.shields.io/github/v/release/PierrickMartos/stint" alt="Latest release"></a>
  <a href="https://github.com/PierrickMartos/stint/actions/workflows/release.yml"><img src="https://github.com/PierrickMartos/stint/actions/workflows/release.yml/badge.svg" alt="Release build"></a>
</p>

<p align="center">
  <img src="images/ready.png" alt="Stint ready to start" width="290">
  <img src="images/running.png" alt="Stint focusing — countdown running" width="290">
  <img src="images/done.png" alt="Stint completion — time's up" width="290">
</p>

## Features

|  |  |
|---|---|
| **One-click start** | Presets for 5 / 10 / 15 / 30 minutes start the countdown immediately. Click the big numerals to type any custom duration (`12:30`, `7`, `12.5`). |
| **The countdown is the hero** | A large tabular display with a depleting progress ring. Distinct, calm states for ready / focusing / paused / time's up. |
| **Gentle alarm + native notification** | A soft two-note chime repeats until dismissed, paired with a macOS notification — you won't miss the end, and it won't startle you. |
| **Compact mode** | Collapse the window to a slim 376×116 glanceable bar that floats anywhere on your desktop, with the essentials one click away. |
| **Accurate & relaunch-safe** | The engine counts down to an absolute end timestamp — never a decrementing counter — so it stays exact through sleep, hidden windows, and even an app restart mid-timer. |
| **Keyboard-first** | `Space` to start / pause / resume, `Esc` to cancel. That's the whole manual. |
| **Tiny footprint** | A native Tauri app using the system WebView: the whole thing is ~8 MB. |

## Install

> **macOS only** (universal binary — Apple Silicon & Intel).

### One-liner (recommended)

Installs the latest release into `/Applications` — run the same command again any time to update:

```bash
curl -fsSL https://raw.githubusercontent.com/PierrickMartos/stint/main/scripts/install.sh | bash
```

Because the script downloads via `curl`, the app arrives without Gatekeeper's quarantine flag and opens straight away.

### Or download the DMG

Grab [the latest `.dmg`](https://github.com/PierrickMartos/stint/releases/latest) and drag **Stint** to Applications. The app is not notarized (no Apple Developer account), so after a browser download macOS will object on first launch — clear it with:

```bash
xattr -dr com.apple.quarantine /Applications/Stint.app
```

### Or build from source

```bash
# 1. One-time: Rust + Node
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
brew install node

# 2. Clone and build
git clone https://github.com/PierrickMartos/stint.git
cd stint
npm install
npm run tauri build

# 3. The app lands in src-tauri/target/release/bundle/macos/Stint.app
```

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Space` | Start · pause · resume — and stop the alarm when time's up |
| `Esc` | Cancel the running timer / dismiss the alarm |
| Click the time | Set a custom duration (idle only) — `Enter` confirms, `Esc` aborts |

## How it works

1. **Timestamp engine** — starting a timer stores an absolute end time; every frame derives `remaining = endTime − now`. Pausing freezes the remainder; resuming recomputes the end time. A `setTimeout` fallback guarantees completion fires even when rendering is throttled in a hidden window.
2. **Relaunch-safe** — lifecycle changes persist to local storage. Quit mid-countdown and reopen: the timer is still running, on time. A timer that expired while the app was closed resets quietly instead of blaring the alarm at launch.
3. **Isolated side-effects** — all completion behavior (WebAudio chime loop, native notification via Tauri's notification plugin) lives behind a single `AlarmAdapter`, and all window-shell concerns (native resize for compact mode, drag regions) behind `shell.ts`.
4. **The window is the app** — a frameless, transparent native window renders the floating panel directly; the compact toggle resizes the real window between 440×560 and 376×116.

## Releases

Tag a version matching `src-tauri/tauri.conf.json` and push — GitHub Actions builds the universal macOS bundle and publishes the DMG:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

## Layout

- `src/engine.ts` — timestamp-based countdown state machine + persistence
- `src/alarm.ts` — chime + native notification behind one adapter
- `src/shell.ts` — Tauri window integration (resize, drag, environment detection)
- `src/main.ts` — DOM wiring and the single render function
- `src-tauri/` — Rust shell, window config, icons (`icon-source.svg` is the mark's source of truth)
- `Timer.html` — the original verified single-file implementation the app derives from

## Design

The interface implements **Direction B — "Soft premium"** from a [Claude Design](https://claude.ai/design) exploration: soft indigo on a deep near-black surface, a depleting ring as the core motif, Material 3 token logic re-seeded away from stock Google styling. The app icon is the "Concentric" mark from the same exploration — two nested countdown arcs, quiet and instrument-like.
