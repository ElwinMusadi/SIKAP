import { describe, expect, it } from 'vitest';
import { createPegawaiSchema, pegawaiListQuerySchema, updatePegawaiSchema } from '@shared/pegawai';
import type { Profile } from '@shared/profile';
import {
  DEFAULT_LIST_PARAMS,
  activeFilterCount,
  buildCreatePayload,
  buildUpdatePayload,
  changedFields,
  clearFilters,
  emptyPegawaiForm,
  listParamsToSearch,
  listQueryString,
  pangkatFamily,
  parseListParams,
  patchListParams,
  profileToForm,
  tabForField,
  toggleSort,
} from './pegawai-utils';

const profile: Profile = {
  id: 7,
  nip: '198501012010011001',
  nama: 'Budi Santoso',
  role: 'Pegawai',
  statusAkun: 'Aktif',
  fotoUrl: null,
  nik: '7371010101850001',
  tempatLahir: 'Makassar',
  tanggalLahir: '1985-01-01',
  jenisKelamin: 'Laki-laki',
  agama: 'Islam',
  pendidikanKode: 'S1',
  statusPernikahan: 'Menikah',
  golonganDarah: null,
  noHp: '6281234567890',
  email: 'budi@contoh.com',
  alamat: 'Jl. Merdeka 1',
  statusKepegawaian: 'PNS',
  pangkatKode: 'III/a',
  tmtPangkat: '2020-04-01',
  jabatan: 'Analis',
  jenisJabatan: 'Fungsional',
  tmtJabatan: null,
  unitId: 3,
  updatedAt: '2026-10-01T00:00:00.000Z',
};

describe('list params ⇄ URL', () => {
  it('parses an empty query to defaults and writes nothing back', () => {
    const p = parseListParams(new URLSearchParams());
    expect(p).toEqual(DEFAULT_LIST_PARAMS);
    expect(listParamsToSearch(p).toString()).toBe('');
    expect(listQueryString(p)).toBe('');
  });

  it('round-trips every filter', () => {
    const search =
      'q=budi&statusKepegawaian=PPPK&statusAkun=Nonaktif&kelengkapan=Perlu+Revisi&belumUnggah=DOC-NPWP&passwordDefault=true&terhapus=true&sort=kelengkapan&dir=desc&page=3&pageSize=50';
    const p = parseListParams(new URLSearchParams(search));
    expect(p).toMatchObject({
      q: 'budi',
      statusKepegawaian: 'PPPK',
      statusAkun: 'Nonaktif',
      kelengkapan: 'Perlu Revisi',
      belumUnggah: 'DOC-NPWP',
      passwordDefault: true,
      terhapus: true,
      sort: 'kelengkapan',
      dir: 'desc',
      page: 3,
      pageSize: 50,
    });
    expect(listParamsToSearch(p).toString()).toBe(search);
  });

  it('drops invalid values instead of sending them to the server', () => {
    const p = parseListParams(
      new URLSearchParams('statusKepegawaian=Honorer&statusAkun=x&kelengkapan=y&sort=foo&dir=up&page=-2&pageSize=17&passwordDefault=1'),
    );
    expect(p).toEqual(DEFAULT_LIST_PARAMS);
  });

  it('produces a query the shared server schema accepts', () => {
    const p = { ...DEFAULT_LIST_PARAMS, q: 'ani', statusAkun: 'Aktif' as const, passwordDefault: true, page: 2, pageSize: 20 as const };
    const parsed = pegawaiListQuerySchema.parse(Object.fromEntries(listParamsToSearch(p)));
    expect(parsed).toMatchObject({ q: 'ani', statusAkun: 'Aktif', passwordDefault: true, terhapus: false, page: 2, pageSize: 20 });
  });

  it('resets the page on filter changes but not on page changes', () => {
    const p = { ...DEFAULT_LIST_PARAMS, page: 4 };
    expect(patchListParams(p, { statusAkun: 'Aktif' }).page).toBe(1);
    expect(patchListParams(p, { page: 5 }).page).toBe(5);
  });

  it('toggles sort direction on the same column and starts ascending on a new one', () => {
    expect(toggleSort(DEFAULT_LIST_PARAMS, 'nama')).toEqual({ sort: 'nama', dir: 'desc' });
    expect(toggleSort({ ...DEFAULT_LIST_PARAMS, dir: 'desc' }, 'nip')).toEqual({ sort: 'nip', dir: 'asc' });
  });

  it('counts and clears filters while keeping tab, sort and page size', () => {
    const p = { ...DEFAULT_LIST_PARAMS, q: 'x', passwordDefault: true, terhapus: true, sort: 'nip' as const, pageSize: 30 as const, page: 2 };
    expect(activeFilterCount(p)).toBe(2);
    expect(clearFilters(p)).toEqual({ ...DEFAULT_LIST_PARAMS, terhapus: true, sort: 'nip', pageSize: 30 });
  });
});

describe('form payloads', () => {
  it('maps a profile to string form values', () => {
    const v = profileToForm(profile);
    expect(v.unitId).toBe('3');
    expect(v.noHp).toBe('081234567890');
    expect(v.golonganDarah).toBe('');
    expect(v.tmtJabatan).toBe('');
  });

  it('builds a minimal create payload accepted by the shared schema', () => {
    const v = { ...emptyPegawaiForm(), nip: ' 198501012010011001 ', nama: 'Ani', statusKepegawaian: 'PPPK', unitId: '2' };
    const body = buildCreatePayload(v);
    expect(body).toEqual({ nip: '198501012010011001', nama: 'Ani', role: 'Pegawai', statusKepegawaian: 'PPPK', unitId: 2 });
    expect(createPegawaiSchema.safeParse(body).success).toBe(true);
  });

  it('sends only changed fields plus expectedUpdatedAt on update', () => {
    const initial = profileToForm(profile);
    const values = { ...initial, nama: 'Budi S.', pangkatKode: '', unitId: '5', alamat: '  Jl. Merdeka 1 ' };
    expect(changedFields(values, initial)).toEqual(['nama', 'pangkatKode', 'unitId']);
    const body = buildUpdatePayload(values, initial, profile.updatedAt);
    expect(body).toEqual({ nama: 'Budi S.', pangkatKode: null, unitId: 5, expectedUpdatedAt: profile.updatedAt });
    expect(updatePegawaiSchema.safeParse(body).success).toBe(true);
  });

  it('returns an empty body when nothing changed and never sends NIP', () => {
    const initial = profileToForm(profile);
    expect(buildUpdatePayload({ ...initial, nip: '000' }, initial, 'x')).toEqual({});
  });

  it('clears optional profile fields with an empty string', () => {
    const initial = profileToForm(profile);
    const body = buildUpdatePayload({ ...initial, email: '' }, initial, 'x');
    expect(updatePegawaiSchema.parse(body)).toMatchObject({ email: null });
  });

  it('maps fields to tabs and statuses to pangkat families', () => {
    expect(tabForField('nik')).toBe('identitas');
    expect(tabForField('unitId')).toBe('kepegawaian');
    expect(tabForField('email')).toBe('kontak');
    expect(tabForField('_form')).toBe('identitas');
    expect(pangkatFamily('CPNS')).toBe('PNS');
    expect(pangkatFamily('PPPK')).toBe('PPPK');
    expect(pangkatFamily('')).toBeNull();
  });
});
