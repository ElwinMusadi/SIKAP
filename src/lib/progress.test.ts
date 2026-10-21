import { describe, expect, it } from 'vitest';
import { countsFromSummary, progressPercent, progressSummary, progressTotal } from './progress';

describe('progress', () => {
  it('computes the verified share, floored', () => {
    expect(progressPercent({ terverifikasi: 0, menunggu: 0, ditolak: 0, belum: 0 })).toBe(0);
    expect(progressPercent({ terverifikasi: 9, menunggu: 0, ditolak: 0, belum: 0 })).toBe(100);
    expect(progressPercent({ terverifikasi: 2, menunggu: 1, ditolak: 0, belum: 0 })).toBe(66);
    // 249/250 = 99.6% must not read as complete.
    expect(progressPercent({ terverifikasi: 249, menunggu: 1, ditolak: 0, belum: 0 })).toBe(99);
  });

  it('totals every segment and summarises in Indonesian', () => {
    const counts = { terverifikasi: 3, menunggu: 2, ditolak: 1, belum: 4 };
    expect(progressTotal(counts)).toBe(10);
    expect(progressSummary(counts)).toBe('3 dari 10 dokumen wajib terverifikasi, 2 menunggu, 1 ditolak, 4 belum diunggah');
  });

  it('derives counts from the list summary without negatives', () => {
    expect(countsFromSummary({ wajibTotal: 9, wajibTerverifikasi: 3, menunggu: 2 })).toEqual({
      terverifikasi: 3,
      menunggu: 2,
      ditolak: 0,
      belum: 4,
    });
    // `menunggu` can include optional documents: it is capped by what is still outstanding.
    expect(countsFromSummary({ wajibTotal: 2, wajibTerverifikasi: 2, menunggu: 3 })).toEqual({
      terverifikasi: 2,
      menunggu: 0,
      ditolak: 0,
      belum: 0,
    });
  });
});
