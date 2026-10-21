import { describe, expect, it } from 'vitest';
import type { AdminJenisDokumen } from '@shared/administrasi';
import {
  EMPTY_JENIS_FILTERS,
  buildCreatePayload,
  buildUpdatePayload,
  emptyJenisForm,
  filterJenis,
  impactfulChanges,
  jenisToForm,
  mapFieldErrors,
} from './jenis-utils';

const item: AdminJenisDokumen = {
  id: 'DOC-SK-CPNS',
  nama: 'SK CPNS',
  kategori: 'Kepegawaian',
  urutan: 10,
  aktif: true,
  maxSizeBytes: 2 * 1024 * 1024,
  wajibUntuk: ['PNS', 'CPNS'],
  updatedAt: '2026-10-16T01:00:00.000Z',
};

describe('jenis form', () => {
  it('builds a valid create payload in bytes', () => {
    const result = buildCreatePayload({ ...emptyJenisForm(5), id: 'doc-ktp', nama: 'KTP', kategori: 'Identitas', maxMb: '1,5', wajibUntuk: ['PPPK', 'PNS'] });
    expect(result).toEqual({
      ok: true,
      data: { id: 'DOC-KTP', nama: 'KTP', kategori: 'Identitas', urutan: 5, maxSizeBytes: 1572864, aktif: true, wajibUntuk: ['PNS', 'PPPK'] },
    });
  });

  it('rejects size outside 1..5 MB and non-integer urutan', () => {
    const result = buildCreatePayload({ ...emptyJenisForm(), id: 'DOC-X1', nama: 'Xx', kategori: 'Ab', maxMb: '6', urutan: '1.5' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(Object.keys(result.errors).sort()).toEqual(['maxMb', 'urutan']);
  });

  it('sends only changed fields with expectedUpdatedAt', () => {
    const result = buildUpdatePayload({ ...jenisToForm(item), wajibUntuk: ['CPNS', 'PNS'], nama: 'SK CPNS 80%' }, item);
    expect(result).toEqual({ ok: true, data: { expectedUpdatedAt: item.updatedAt, nama: 'SK CPNS 80%' } });
    const none = buildUpdatePayload(jenisToForm(item), item);
    expect(none.ok).toBe(false);
  });

  it('flags retroactive changes', () => {
    expect(impactfulChanges(jenisToForm(item), item)).toEqual({ wajib: false, aktif: false });
    expect(impactfulChanges({ ...jenisToForm(item), wajibUntuk: ['PNS'], aktif: false }, item)).toEqual({ wajib: true, aktif: true });
    expect(impactfulChanges(emptyJenisForm(), null)).toEqual({ wajib: false, aktif: false });
  });

  it('maps server fields to form fields', () => {
    expect(mapFieldErrors({ maxSizeBytes: 'x', id: 'y', other: 'z' })).toEqual({ maxMb: 'x', id: 'y', form: 'z' });
  });
});

describe('filterJenis', () => {
  const list: AdminJenisDokumen[] = [
    item,
    { ...item, id: 'DOC-KTP', nama: 'Kartu Tanda Penduduk', kategori: 'Pribadi', wajibUntuk: ['PNS', 'CPNS', 'PPPK'] },
    { ...item, id: 'DOC-KARPEG', nama: 'Kartu Pegawai', aktif: false, wajibUntuk: [] },
  ];
  const ids = (filters: Partial<typeof EMPTY_JENIS_FILTERS>) => filterJenis(list, { ...EMPTY_JENIS_FILTERS, ...filters }).map((i) => i.id);

  it('searches nama and ID case-insensitively', () => {
    expect(ids({ q: 'kartu' })).toEqual(['DOC-KTP', 'DOC-KARPEG']);
    expect(ids({ q: 'sk-cpns' })).toEqual(['DOC-SK-CPNS']);
  });

  it('combines kategori, status and wajib facets', () => {
    expect(ids({ kategori: 'Kepegawaian', status: 'aktif' })).toEqual(['DOC-SK-CPNS']);
    expect(ids({ status: 'nonaktif' })).toEqual(['DOC-KARPEG']);
    expect(ids({ wajib: 'PPPK' })).toEqual(['DOC-KTP']);
  });
});
