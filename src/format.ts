/** Pure time-formatting helpers (no DOM, no side effects). */

export interface TimeParts {
  /** Minutes without padding — "5", "25". */
  m: string;
  /** Minutes, zero-padded — "05", "25". */
  mm: string;
  /** Seconds, zero-padded — "00", "07". */
  ss: string;
}

export function fmt(totalSec: number): TimeParts {
  const s = Math.max(0, Math.ceil(totalSec));
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return {
    m: String(m),
    mm: String(m).padStart(2, '0'),
    ss: String(ss).padStart(2, '0'),
  };
}

/** Parse "MM:SS", "M:SS", or plain minutes ("15", "12.5"). Returns seconds, or null if invalid/≤0. */
export function parseDuration(str: string): number | null {
  str = (str || '').trim();
  if (!str) return null;
  if (str.includes(':')) {
    const [a, b] = str.split(':');
    const m = parseInt(a, 10) || 0;
    const s = parseInt(b, 10) || 0;
    const tot = m * 60 + s;
    return tot > 0 ? tot : null;
  }
  const mins = parseFloat(str);
  if (!isFinite(mins) || mins <= 0) return null;
  return Math.round(mins * 60);
}
