/** Local calendar date → 'YYYY-MM-DD' (never toISOString: that would shift by the UTC offset). */
export function toIsoDate(date: Date): string {
  const y = String(date.getFullYear()).padStart(4, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * 'YYYY-MM-DD' → local Date at midnight, or undefined when empty or not a real
 * calendar date (e.g. '2026-02-31' is rejected instead of rolling over to March).
 */
export function fromIsoDate(value: string | null | undefined): Date | undefined {
  if (!value) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return undefined;
  const date = new Date(year, month - 1, day);
  // Strict round trip: any overflow (day 31 in a 30-day month, Feb 29 in a common year) changes a component.
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return undefined;
  return date;
}
