import { describe, expect, it } from 'vitest';
import type { RefResponse } from '@shared/profile';
import { formatKepegawaianValue, formatPhone, fromIsoDate, phoneForInput, toIsoDate } from './format-values';

const ref: RefResponse = {
  pangkat: [{ kode: 'III/a', nama: 'Penata Muda (III/a)', jenisAsn: 'PNS' }],
  unit: [{ id: 3, nama: 'Seksi Penagihan' }],
  pendidikan: [],
  jenisDokumen: [],
};

describe('formatKepegawaianValue', () => {
  it('maps pangkat and unit to ref names', () => {
    expect(formatKepegawaianValue('pangkatKode', 'III/a', ref)).toBe('Penata Muda (III/a)');
    expect(formatKepegawaianValue('unitId', 3, ref)).toBe('Seksi Penagihan');
  });
  it('falls back to the raw value when unknown', () => {
    expect(formatKepegawaianValue('pangkatKode', 'IV/e', ref)).toBe('IV/e');
  });
  it('formats dates and empty values', () => {
    expect(formatKepegawaianValue('tmtPangkat', '2024-04-01', ref)).toBe('1 April 2024');
    expect(formatKepegawaianValue('jabatan', null, ref)).toBe('—');
  });
});

describe('phone', () => {
  it('formats normalised numbers for display', () => {
    expect(formatPhone('6281234567890')).toBe('0812-3456-7890');
    expect(formatPhone(null)).toBe('—');
  });
  it('converts to national format for inputs', () => {
    expect(phoneForInput('6281234567890')).toBe('081234567890');
  });
});

describe('iso dates', () => {
  it('round-trips without timezone shift', () => {
    const date = fromIsoDate('1990-01-31');
    expect(date?.getDate()).toBe(31);
    expect(toIsoDate(date!)).toBe('1990-01-31');
  });
});
