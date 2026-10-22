import { describe, expect, it } from 'vitest';
import { MASA_BERLAKU_HARI } from '@shared/integrasi';
import { MASA_BERLAKU_OPTIONS, SEGERA_KEDALUWARSA_HARI, apiBaseUrl, kunciLabel, kunciStatus, masaBerlakuLabel, sisaHari } from './kunci-api-utils';

const NOW = Date.parse('2026-10-22T00:00:00.000Z');
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

describe('kunciStatus', () => {
  it('is Aktif beyond the warning window, Segera kedaluwarsa within it, Kedaluwarsa from the expiry instant', () => {
    expect(kunciStatus(iso(NOW + 365 * DAY), NOW)).toBe('Aktif');
    expect(kunciStatus(iso(NOW + SEGERA_KEDALUWARSA_HARI * DAY + 1), NOW)).toBe('Aktif');
    expect(kunciStatus(iso(NOW + SEGERA_KEDALUWARSA_HARI * DAY), NOW)).toBe('Segera kedaluwarsa');
    expect(kunciStatus(iso(NOW + 1), NOW)).toBe('Segera kedaluwarsa');
    expect(kunciStatus(iso(NOW), NOW)).toBe('Kedaluwarsa');
    expect(kunciStatus(iso(NOW - DAY), NOW)).toBe('Kedaluwarsa');
  });

  it('treats an unparseable date as expired (fail closed)', () => {
    expect(kunciStatus('bukan-tanggal', NOW)).toBe('Kedaluwarsa');
  });
});

describe('sisaHari', () => {
  it('rounds partial days up and never goes negative', () => {
    expect(sisaHari(iso(NOW + 90 * DAY), NOW)).toBe(90);
    expect(sisaHari(iso(NOW + 1), NOW)).toBe(1);
    expect(sisaHari(iso(NOW), NOW)).toBe(0);
    expect(sisaHari(iso(NOW - 5 * DAY), NOW)).toBe(0);
    expect(sisaHari('x', NOW)).toBe(0);
  });
});

describe('labels', () => {
  it('shows only the public part of a key', () => {
    expect(kunciLabel('ab12cd34ef56')).toBe('skp_ab12cd34ef56…');
  });

  it('offers exactly the server-accepted validity periods', () => {
    expect(MASA_BERLAKU_OPTIONS.map((o) => Number(o.value))).toEqual([...MASA_BERLAKU_HARI]);
    expect(masaBerlakuLabel(90)).toBe('90 hari');
    expect(masaBerlakuLabel(365)).toBe('1 tahun (365 hari)');
  });

  it('builds the v1 base URL without double slashes', () => {
    expect(apiBaseUrl('https://sikap.uptdpenda-kupang.web.id')).toBe('https://sikap.uptdpenda-kupang.web.id/api/v1');
    expect(apiBaseUrl('http://localhost:8788/')).toBe('http://localhost:8788/api/v1');
  });
});
