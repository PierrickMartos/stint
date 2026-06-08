/**
 * Stint — Focus Timer (Direction B "Soft premium")
 * DOM wiring + render. State lives in TimerEngine; completion side-effects in
 * AlarmAdapter; native-shell concerns (window resize, notifications) behind
 * shell.ts / alarm.ts.
 */
import './styles.css';
import { fmt, parseDuration } from './format';
import { TimerEngine } from './engine';
import { AlarmAdapter } from './alarm';
import { MusicAdapter, sourceLabel } from './music';
import { loadSettings, saveSettings } from './settings';
import { isTauri, resizeWindow, setKeepAwake, wireDragRegions } from './shell';

const PRESETS = [5, 10, 15, 30];
const COMPACT_KEY = 'stint.compact';
const RING_CIRC = 2 * Math.PI * 131.5; // r = (268 - 5) / 2

// ── DOM refs ────────────────────────────────────────────────────────────────
const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const win = $('window');
const app = $('app');
const appCompact = $('app-compact');
const modeLabel = $('mode-label');
const ringProg = document.getElementById('ring-progress') as unknown as SVGCircleElement;
const dispMM = $('disp-mm');
const dispSS = $('disp-ss');
const timeBtn = $('time-btn');
const timeInput = $<HTMLInputElement>('time-input');
const startLabel = $('start-label');
const presetRow = $('preset-row');
const presetRowDone = $('preset-row-done');
const compactTime = $('compact-time');
const compactFill = $('compact-fill');
const compactPresets = $('compact-presets');

// init ring dash
ringProg.setAttribute('stroke-dasharray', String(RING_CIRC));
ringProg.setAttribute('stroke-dashoffset', String(RING_CIRC));

// ── Render (single explicit state-machine view fn) ──────────────────────────
const MODE_LABELS: Record<string, string> = {
  idle: 'Ready',
  running: 'Focusing',
  paused: 'Paused',
  done: 'Time’s up',
};

function render(): void {
  const mode = engine.mode;
  const disp = fmt(engine.remaining);
  const frac =
    engine.total > 0 ? Math.max(0, Math.min(1, engine.remaining / engine.total)) : 0;

  // mode attribute drives all CSS state styling
  app.setAttribute('data-mode', mode);
  appCompact.setAttribute('data-mode', mode);

  modeLabel.textContent = MODE_LABELS[mode];

  // numerals (skip the big display while editing)
  if (!engine.editing) {
    dispMM.textContent = disp.mm;
    dispSS.textContent = disp.ss;
  }
  compactTime.textContent = `${disp.mm}:${disp.ss}`;

  // start label (idle)
  startLabel.textContent = `Start ${fmt(engine.total).m} min`;

  // ring progress
  const active = mode === 'running' || mode === 'paused' || mode === 'done';
  ringProg.setAttribute(
    'stroke-dashoffset',
    String(active ? RING_CIRC * (1 - frac) : RING_CIRC),
  );

  // compact baseline progress
  const showBar = mode === 'running' || mode === 'paused';
  compactFill.style.width = `${showBar ? frac * 100 : 0}%`;
}

const settings = loadSettings();
MusicAdapter.setEnabled(settings.music);
MusicAdapter.setVolume(settings.volume);
MusicAdapter.setSource(settings.musicSource);

const engine = new TimerEngine(AlarmAdapter, MusicAdapter, render, (on) =>
  void setKeepAwake(on),
);

// ── Build preset buttons ─────────────────────────────────────────────────────
function presetButton(p: number, small: boolean): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'preset-btn' + (small ? ' small' : '');
  b.innerHTML = `${p}<span class="unit">m</span>`;
  b.addEventListener('click', () => engine.startWith(p * 60));
  return b;
}
PRESETS.forEach((p) => {
  presetRow.appendChild(presetButton(p, false));
  presetRowDone.appendChild(presetButton(p, true));
});
// compact: three mini chips (5/10/15)
PRESETS.slice(0, 3).forEach((p) => {
  const b = document.createElement('button');
  b.className = 'mini-chip';
  b.textContent = String(p);
  b.addEventListener('click', () => engine.startWith(p * 60));
  compactPresets.appendChild(b);
});

// ── Custom-duration inline editing ───────────────────────────────────────────
function beginEdit(): void {
  if (engine.mode !== 'idle') return;
  engine.editing = true;
  const f = fmt(engine.total);
  timeInput.value = `${f.mm}:${f.ss}`;
  timeBtn.style.display = 'none';
  timeInput.style.display = '';
  timeInput.focus();
  timeInput.select();
}
function endEdit(): void {
  engine.editing = false;
  timeInput.style.display = 'none';
  timeBtn.style.display = '';
  render();
}
function commitEdit(): void {
  const sec = parseDuration(timeInput.value);
  if (sec) engine.setDuration(sec);
  endEdit();
}
timeBtn.addEventListener('click', beginEdit);
timeInput.addEventListener('blur', () => {
  if (engine.editing) commitEdit();
});
timeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    commitEdit();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    endEdit();
  }
});

// ── Control wiring ───────────────────────────────────────────────────────────
$('start-btn').addEventListener('click', () => engine.start());
$('pauseresume-btn').addEventListener('click', () =>
  engine.mode === 'running' ? engine.pause() : engine.resume(),
);
$('cancel-btn').addEventListener('click', () => engine.cancel());
$('stopalarm-btn').addEventListener('click', () => engine.stopSound());
$('restart-btn').addEventListener('click', () => engine.restart());
$('compact-pauseresume').addEventListener('click', () =>
  engine.mode === 'running' ? engine.pause() : engine.resume(),
);
$('compact-stopalarm').addEventListener('click', () => engine.stopSound());

// ── Settings panel (gear → overlay; music opt-out + Space default preset) ───
const settingsBtn = $('toggle-settings');
const musicToggle = $('music-toggle');
const muteBtns = [$('mute-btn'), $('mute-btn-compact')];
const volumeSlider = $<HTMLInputElement>('music-volume');
const sourceInput = $<HTMLInputElement>('music-source');
const sourceHint = $('music-source-hint');
const settingsPresetRow = $('settings-preset-row');
const settingsPresetLast = $('settings-preset-last');

let settingsOpen = false;

function renderSettings(): void {
  musicToggle.classList.toggle('on', settings.music);
  musicToggle.setAttribute('aria-checked', String(settings.music));
  muteBtns.forEach((b) => {
    b.querySelector('.material-symbols-outlined')!.textContent = settings.music
      ? 'music_note'
      : 'music_off';
    b.setAttribute('aria-pressed', String(!settings.music));
    b.title = settings.music ? 'Mute focus music' : 'Unmute focus music';
  });
  volumeSlider.value = String(Math.round(settings.volume * 100));
  sourceInput.value = settings.musicSource;
  sourceHint.textContent = sourceLabel(settings.musicSource);
  settingsPresetLast.classList.toggle('selected', settings.defaultPresetMin == null);
  presetChips.forEach(([min, btn]) =>
    btn.classList.toggle('selected', settings.defaultPresetMin === min),
  );
}

function setSettingsOpen(on: boolean): void {
  settingsOpen = on;
  app.classList.toggle('settings-open', on);
  settingsBtn.setAttribute('aria-expanded', String(on));
  // Refocus the app container on close so Space/Esc shortcuts keep working.
  if (!on) app.focus();
}

settingsBtn.addEventListener('click', () => setSettingsOpen(!settingsOpen));

// Outside click closes the panel (capture so it wins over other handlers).
document.addEventListener('mousedown', (e) => {
  if (!settingsOpen) return;
  const t = e.target as Element;
  if (t.closest('#settings-panel') || t.closest('#toggle-settings')) return;
  setSettingsOpen(false);
});

// The panel switch and the chrome mute button are two views of the same flag.
function toggleMusic(): void {
  settings.music = !settings.music;
  saveSettings(settings);
  MusicAdapter.setEnabled(settings.music);
  renderSettings();
}
musicToggle.addEventListener('click', toggleMusic);
muteBtns.forEach((b) => b.addEventListener('click', toggleMusic));

volumeSlider.addEventListener('input', () => {
  settings.volume = Number(volumeSlider.value) / 100;
  saveSettings(settings);
  MusicAdapter.setVolume(settings.volume);
});

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

function selectDefaultPreset(min: number | null): void {
  settings.defaultPresetMin = min;
  saveSettings(settings);
  renderSettings();
}
settingsPresetLast.addEventListener('click', () => selectDefaultPreset(null));
const presetChips: Array<[number, HTMLButtonElement]> = PRESETS.map((p) => {
  const b = document.createElement('button');
  b.className = 'preset-btn small';
  b.innerHTML = `${p}<span class="unit">m</span>`;
  b.addEventListener('click', () => selectDefaultPreset(p));
  settingsPresetRow.appendChild(b);
  return [p, b];
});
renderSettings();

// ── Compact toggle (persisted; resizes the native window in Tauri) ──────────
function setCompact(on: boolean): void {
  win.classList.toggle('compact', on);
  void resizeWindow(on);
  try {
    localStorage.setItem(COMPACT_KEY, on ? '1' : '0');
  } catch {
    /* non-fatal */
  }
  // Move focus to the now-visible layout so keyboard shortcuts keep working.
  (on ? appCompact : app).focus();
}
$('toggle-compact').addEventListener('click', () => {
  if (settingsOpen) setSettingsOpen(false); // panel lives in the expanded layout
  setCompact(true);
});
$('expand-btn').addEventListener('click', () => setCompact(false));

// ── Keyboard ─────────────────────────────────────────────────────────────────
// Wired on both layouts so shortcuts work whether expanded or compact is visible.
function handleKeydown(e: KeyboardEvent): void {
  if (engine.editing) return;
  if (settingsOpen) {
    // Panel owns the keyboard: Esc closes it (without cancelling the timer),
    // Space stays free to activate the focused control.
    if (e.key === 'Escape') {
      e.preventDefault();
      setSettingsOpen(false);
    }
    return;
  }
  if (e.key === ' ' || e.code === 'Space') {
    e.preventDefault();
    if (engine.mode === 'idle') {
      settings.defaultPresetMin != null
        ? engine.startWith(settings.defaultPresetMin * 60)
        : engine.start();
    } else if (engine.mode === 'running') engine.pause();
    else if (engine.mode === 'paused') engine.resume();
    else if (engine.mode === 'done') engine.stopSound();
  } else if (e.key === 'Escape') {
    if (engine.mode === 'running' || engine.mode === 'paused') engine.cancel();
    else if (engine.mode === 'done') engine.stopSound();
  }
}
app.addEventListener('keydown', handleKeydown);
appCompact.addEventListener('keydown', handleKeydown);

// ── Boot ─────────────────────────────────────────────────────────────────────
wireDragRegions();
engine.restore();

let compactPref = false;
try {
  compactPref = localStorage.getItem(COMPACT_KEY) === '1';
} catch {
  /* default expanded */
}
win.classList.toggle('compact', compactPref);
if (isTauri && compactPref) void resizeWindow(true);

render();
// Focus the visible layout so keyboard shortcuts work from boot in either mode.
(compactPref ? appCompact : app).focus();
