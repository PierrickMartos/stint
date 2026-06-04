# Music source override — design

**Date:** 2026-06-04
**Status:** Approved

## Goal

Let the user paste a link in settings to replace the bundled focus track: either a
direct audio URL (streamed in-app, cross-platform) or a Spotify song/playlist link
(drives the local Spotify desktop app, macOS only). Empty field = bundled track,
today's behavior.

## Decisions made

- **Scope:** both audio URL and Spotify-local control (macOS via AppleScript).
- **UI:** one smart "Music source" text field; mode auto-detected from the value.
- **Volume:** Stint's slider only affects in-app audio. In Spotify mode it does
  nothing audible; the mute toggle still pauses/resumes Spotify.
- **Spotify bridge:** custom `#[tauri::command]` running `osascript` with fixed
  scripts (play URI / pause / resume). No shell plugin, no Web API/OAuth.
  Rationale: smallest dependency and permission surface; Web API needs Premium +
  OAuth and was rejected as out of proportion.

## Settings (`src/settings.ts`)

New field on `Settings`:

```ts
/** Music override: '' = bundled, http(s) URL = stream, Spotify link/URI = local app. */
musicSource: string;
```

Default `''`. Saved trimmed; loaded with the same defensive typing as existing
fields (non-string → default).

## Source detection (pure function in `src/music.ts`)

Classify the stored string:

| Input | Mode |
|---|---|
| `spotify:track/playlist/album:ID` URI or `open.spotify.com/{track,playlist,album}/ID` URL | **spotify** (normalized to the `spotify:` URI form) |
| any other `http://` / `https://` URL | **stream** (used as `<audio>` src) |
| empty or unrecognized | **bundled** |

## Settings panel (`src/main.ts` + CSS)

A "Music source" text input under the existing music switch, with a small caption
that live-updates to the detected mode: "Bundled track" / "Custom audio URL" /
"Spotify (macOS)". No new switches. Follows the existing panel row styling.

## `src/music.ts`

Remains the single `MusicPort`; gains `setSource(source: string)`. Lifecycle
calls route to one of two internal backends:

- **Audio backend** — the existing `<audio>` logic, with src = override URL or
  the bundled asset. Behavior unchanged, including the autoplay-retry guard.
- **Spotify backend** — `start` → play the URI with repeat enabled (so a single
  track outlasts the session); `pause`/`stop` → pause Spotify; `resume` →
  resume. `setEnabled(false/true)` pauses/resumes. `setVolume` is a no-op.

The engine's invariant (`music.stop()` before `alarm.start()` on completion)
holds for free — the engine already orders the calls; the Spotify backend's
`stop` pauses the app before the chime starts.

## `src/shell.ts`

`spotifyControl(action: 'play' | 'pause' | 'resume', uri?: string): Promise<boolean>`
wrapping `invoke('spotify_control', …)`. Resolves `false` outside Tauri or on
command error. Preserves the rule that nothing else imports `@tauri-apps/*`.

## Rust (`src-tauri`)

One `spotify_control` command spawning `osascript` with a fixed AppleScript per
action. Compiled for macOS only (`#[cfg(target_os = "macos")]`); other targets
return `Err`, which the frontend treats as fallback. Spotify launches itself if
installed but not running (AppleScript default — desired). First use triggers
the macOS automation permission prompt; a denial surfaces as an osascript error
and falls back like any other failure.

## Failure handling — always fall back to bundled, never silence

| Failure | Behavior |
|---|---|
| Spotify mode on non-macOS / browser dev mode | audio backend plays bundled track |
| osascript error (Spotify missing, automation denied) | bundled track for that session |
| Stream URL fails to load (`error` event on `<audio>`) | bundled track for that session |

## Testing

`npm run build` (tsc strict) is the gate. Manual verification:

- `npm run dev` (browser): URL mode plays/loops; bad URL falls back to bundled;
  Spotify link falls back to bundled (no Tauri).
- `npm run tauri dev` (macOS): Spotify link starts/pauses/resumes the desktop
  app across start/pause/resume/cancel/complete; chime never overlaps playback;
  mute toggle pauses/resumes Spotify; volume slider untouched in Spotify mode.

## Out of scope

- Windows/Linux Spotify control (Web API / MPRIS) — Spotify links simply fall
  back to the bundled track there.
- Mapping Stint's volume slider to Spotify's volume.
- Restoring the user's previous Spotify playback state after a session.
