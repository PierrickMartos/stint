/**
 * Shell adapter — the one place that knows whether we're inside the Tauri
 * desktop shell or a plain browser (vite dev preview).
 *
 * In Tauri, the native window IS the floating panel: the compact toggle
 * resizes the real window (440×560 ⇄ 376×116) and `html.in-tauri` collapses
 * the browser-only backdrop presentation (see styles.css).
 */
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';

export const isTauri = '__TAURI_INTERNALS__' in window;

const EXPANDED = { width: 440, height: 560 };
const COMPACT = { width: 376, height: 116 };

export async function resizeWindow(compact: boolean): Promise<void> {
  if (!isTauri) return;
  const size = compact ? COMPACT : EXPANDED;
  await getCurrentWindow().setSize(new LogicalSize(size.width, size.height));
}

/**
 * Explicit drag-region wiring. Tauri's built-in `data-tauri-drag-region`
 * handler only fires when the mousedown target IS the attributed element —
 * children swallow the event. This delegate uses closest() so any
 * non-interactive spot inside a marked region starts a native window drag.
 */
export function wireDragRegions(): void {
  if (!isTauri) return;
  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const target = e.target as Element;
    if (!target.closest('[data-tauri-drag-region]')) return;
    if (target.closest('button, input')) return; // controls stay clickable
    e.preventDefault();
    void getCurrentWindow().startDragging();
  });
}
