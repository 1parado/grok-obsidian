/** Format milliseconds as a human-friendly minutes string for settings UI. */
export function msToMinutesDisplay(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0";
  const minutes = ms / 60_000;
  if (Number.isInteger(minutes)) return String(minutes);
  // Keep one decimal for fractional minutes (e.g. 90s → 1.5)
  const rounded = Math.round(minutes * 10) / 10;
  return String(rounded);
}

/**
 * Parse a minutes field from settings into ms.
 * Accepts integers and decimals; returns null if invalid.
 */
export function minutesInputToMs(input: string, minMs: number): number | null {
  const n = Number(String(input).trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = Math.floor(n * 60_000);
  if (ms < minMs) return null;
  return ms;
}

/** Parse raw ms text (legacy / advanced). */
export function parseMsInput(input: string, minMs: number): number | null {
  const n = Number(String(input).trim());
  if (!Number.isFinite(n) || n < minMs) return null;
  return Math.floor(n);
}
