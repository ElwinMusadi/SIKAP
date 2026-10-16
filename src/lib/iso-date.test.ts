import { describe, expect, it } from 'vitest';
import { fromIsoDate, toIsoDate } from './iso-date';

describe('fromIsoDate', () => {
  it('parses a valid date as local midnight', () => {
    const date = fromIsoDate('1990-07-15');
    expect(date).toBeInstanceOf(Date);
    expect([date!.getFullYear(), date!.getMonth(), date!.getDate(), date!.getHours()]).toEqual([1990, 6, 15, 0]);
  });

  it('rejects an impossible day instead of rolling over', () => {
    expect(fromIsoDate('2026-02-31')).toBeUndefined();
    expect(fromIsoDate('2026-04-31')).toBeUndefined();
    expect(fromIsoDate('2026-01-00')).toBeUndefined();
  });

  it('rejects an invalid month', () => {
    expect(fromIsoDate('2026-13-01')).toBeUndefined();
    expect(fromIsoDate('2026-00-10')).toBeUndefined();
  });

  it('handles leap years', () => {
    expect(fromIsoDate('2024-02-29')?.getDate()).toBe(29);
    expect(fromIsoDate('2023-02-29')).toBeUndefined();
  });

  it('rejects empty and malformed input', () => {
    expect(fromIsoDate('')).toBeUndefined();
    expect(fromIsoDate(null)).toBeUndefined();
    expect(fromIsoDate('15-07-1990')).toBeUndefined();
    expect(fromIsoDate('1990-7-15')).toBeUndefined();
  });
});

describe('toIsoDate', () => {
  it('round-trips without a timezone shift (local components only)', () => {
    for (const iso of ['1990-01-01', '2000-12-31', '2024-02-29', '1985-06-30']) {
      expect(toIsoDate(fromIsoDate(iso)!)).toBe(iso);
    }
  });

  it('uses local components for a date near midnight', () => {
    // 23:59 local time must stay on the same calendar day regardless of the runner's TZ.
    expect(toIsoDate(new Date(2026, 9, 16, 23, 59))).toBe('2026-10-16');
    expect(toIsoDate(new Date(2026, 9, 16, 0, 0))).toBe('2026-10-16');
  });
});
