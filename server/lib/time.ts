// All persisted timestamps are ISO-8601 UTC strings produced by
// `Date#toISOString()` so they compare correctly as TEXT in SQLite.

export function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

export function addMinutes(ms: number, minutes: number): number {
  return ms + minutes * 60_000;
}

export function addHours(ms: number, hours: number): number {
  return ms + hours * 3_600_000;
}

/** Whole seconds from `nowMs` until `isoFuture` (minimum 1). */
export function secondsUntil(isoFuture: string, nowMs: number): number {
  return Math.max(1, Math.ceil((Date.parse(isoFuture) - nowMs) / 1000));
}
