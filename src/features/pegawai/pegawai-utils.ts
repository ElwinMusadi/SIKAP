import { STATUS_AKUN, STATUS_KEPEGAWAIAN, type StatusAkun, type StatusKepegawaian } from '@shared/enums';
import { KELENGKAPAN, PAGE_SIZES, PEGAWAI_SORT, type Kelengkapan, type PegawaiSort } from '@shared/pegawai';
import type { Profile } from '@shared/profile';
import { phoneForInput } from '@/features/profil/format-values';

/* -------------------------------------------------------------------------- */
/* List params  ⇄  URL search params                                          */
/* -------------------------------------------------------------------------- */

export type PageSize = (typeof PAGE_SIZES)[number];
export type SortDir = 'asc' | 'desc';

/** Normalised list state. Lives in the URL so the page is shareable and the back button works. */
export interface PegawaiListParams {
  q: string;
  statusKepegawaian: StatusKepegawaian | null;
  statusAkun: StatusAkun | null;
  kelengkapan: Kelengkapan | null;
  belumUnggah: string | null;
  passwordDefault: boolean;
  terhapus: boolean;
  sort: PegawaiSort;
  dir: SortDir;
  page: number;
  pageSize: PageSize;
}

export const DEFAULT_LIST_PARAMS: PegawaiListParams = {
  q: '',
  statusKepegawaian: null,
  statusAkun: null,
  kelengkapan: null,
  belumUnggah: null,
  passwordDefault: false,
  terhapus: false,
  sort: 'nama',
  dir: 'asc',
  page: 1,
  pageSize: 15,
};

function oneOf<T extends string>(values: readonly T[], raw: string | null): T | null {
  return raw !== null && (values as readonly string[]).includes(raw) ? (raw as T) : null;
}

/** Unknown or invalid values fall back to defaults instead of producing a 400 from the server. */
export function parseListParams(sp: URLSearchParams): PegawaiListParams {
  const page = Number(sp.get('page'));
  const pageSize = Number(sp.get('pageSize'));
  const belumUnggah = (sp.get('belumUnggah') ?? '').trim().slice(0, 64);
  return {
    q: (sp.get('q') ?? '').trim().slice(0, 100),
    statusKepegawaian: oneOf(STATUS_KEPEGAWAIAN, sp.get('statusKepegawaian')),
    statusAkun: oneOf(STATUS_AKUN, sp.get('statusAkun')),
    kelengkapan: oneOf(KELENGKAPAN, sp.get('kelengkapan')),
    belumUnggah: belumUnggah || null,
    passwordDefault: sp.get('passwordDefault') === 'true',
    terhapus: sp.get('terhapus') === 'true',
    sort: oneOf(PEGAWAI_SORT, sp.get('sort')) ?? DEFAULT_LIST_PARAMS.sort,
    dir: sp.get('dir') === 'desc' ? 'desc' : 'asc',
    page: Number.isInteger(page) && page >= 1 && page <= 10_000 ? page : 1,
    pageSize: (PAGE_SIZES as readonly number[]).includes(pageSize) ? (pageSize as PageSize) : DEFAULT_LIST_PARAMS.pageSize,
  };
}

/** Only non-default values are written, so a clean list has a clean URL. Same keys as the API query. */
export function listParamsToSearch(p: PegawaiListParams): URLSearchParams {
  const sp = new URLSearchParams();
  if (p.q) sp.set('q', p.q);
  if (p.statusKepegawaian) sp.set('statusKepegawaian', p.statusKepegawaian);
  if (p.statusAkun) sp.set('statusAkun', p.statusAkun);
  if (p.kelengkapan) sp.set('kelengkapan', p.kelengkapan);
  if (p.belumUnggah) sp.set('belumUnggah', p.belumUnggah);
  if (p.passwordDefault) sp.set('passwordDefault', 'true');
  if (p.terhapus) sp.set('terhapus', 'true');
  if (p.sort !== DEFAULT_LIST_PARAMS.sort) sp.set('sort', p.sort);
  if (p.dir !== DEFAULT_LIST_PARAMS.dir) sp.set('dir', p.dir);
  if (p.page !== 1) sp.set('page', String(p.page));
  if (p.pageSize !== DEFAULT_LIST_PARAMS.pageSize) sp.set('pageSize', String(p.pageSize));
  return sp;
}

/** '?q=…' or '' for GET /api/admin/pegawai. */
export function listQueryString(p: PegawaiListParams): string {
  const s = listParamsToSearch(p).toString();
  return s ? `?${s}` : '';
}

/** Applies a change; any change other than `page` itself goes back to page 1. */
export function patchListParams(p: PegawaiListParams, patch: Partial<PegawaiListParams>): PegawaiListParams {
  const next = { ...p, ...patch };
  if (patch.page === undefined) next.page = 1;
  return next;
}

export function activeFilterCount(p: PegawaiListParams): number {
  return [p.q, p.statusKepegawaian, p.statusAkun, p.kelengkapan, p.belumUnggah, p.passwordDefault].filter(Boolean).length;
}

/** Clears filters but keeps the tab, sort and page size. */
export function clearFilters(p: PegawaiListParams): PegawaiListParams {
  return { ...DEFAULT_LIST_PARAMS, terhapus: p.terhapus, sort: p.sort, dir: p.dir, pageSize: p.pageSize };
}

/** Next sort state for a header click: same column flips direction, a new column starts ascending. */
export function toggleSort(p: PegawaiListParams, field: PegawaiSort): Pick<PegawaiListParams, 'sort' | 'dir'> {
  if (p.sort === field) return { sort: field, dir: p.dir === 'asc' ? 'desc' : 'asc' };
  return { sort: field, dir: 'asc' };
}

/* -------------------------------------------------------------------------- */
/* Form values  ⇄  API payloads                                               */
/* -------------------------------------------------------------------------- */

export const IDENTITAS_FIELDS = [
  'nip',
  'nama',
  'role',
  'nik',
  'tempatLahir',
  'tanggalLahir',
  'jenisKelamin',
  'agama',
  'pendidikanKode',
  'statusPernikahan',
  'golonganDarah',
] as const;
export const KEPEGAWAIAN_FORM_FIELDS = [
  'statusKepegawaian',
  'pangkatKode',
  'tmtPangkat',
  'jabatan',
  'jenisJabatan',
  'tmtJabatan',
  'unitId',
] as const;
export const KONTAK_FIELDS = ['noHp', 'email', 'alamat'] as const;
export const PEGAWAI_FORM_FIELDS = [...IDENTITAS_FIELDS, ...KEPEGAWAIAN_FORM_FIELDS, ...KONTAK_FIELDS] as const;

export type PegawaiFormField = (typeof PEGAWAI_FORM_FIELDS)[number];
/** Every value is a string in the form ('' = empty); converted by the payload builders. */
export type PegawaiFormValues = Record<PegawaiFormField, string>;
export type PegawaiFormTab = 'identitas' | 'kepegawaian' | 'kontak';

export function isPegawaiFormField(key: string): key is PegawaiFormField {
  return (PEGAWAI_FORM_FIELDS as readonly string[]).includes(key);
}

export function tabForField(field: string): PegawaiFormTab {
  if ((KEPEGAWAIAN_FORM_FIELDS as readonly string[]).includes(field)) return 'kepegawaian';
  if ((KONTAK_FIELDS as readonly string[]).includes(field)) return 'kontak';
  return 'identitas';
}

export function emptyPegawaiForm(): PegawaiFormValues {
  const values = {} as PegawaiFormValues;
  for (const field of PEGAWAI_FORM_FIELDS) values[field] = '';
  values.role = 'Pegawai';
  return values;
}

export function profileToForm(p: Profile): PegawaiFormValues {
  const values = emptyPegawaiForm();
  for (const field of PEGAWAI_FORM_FIELDS) {
    const raw = p[field];
    values[field] = raw === null || raw === undefined ? '' : String(raw);
  }
  values.noHp = phoneForInput(p.noHp);
  return values;
}

/** Employment fields that are nullable in kepegawaianFieldsSchema ('' must become null, not ''). */
const NULLABLE_KEPEGAWAIAN = new Set<PegawaiFormField>(['pangkatKode', 'tmtPangkat', 'jabatan', 'jenisJabatan', 'tmtJabatan', 'unitId']);

/** Form string → API value. Profile fields keep '' (the shared schema maps '' → null). */
export function toPayloadValue(field: PegawaiFormField, raw: string): unknown {
  const value = raw ?? '';
  if (field === 'unitId') return value.trim() === '' ? null : Number(value);
  if (NULLABLE_KEPEGAWAIAN.has(field)) return value.trim() === '' ? null : value;
  return value;
}

const norm = (v: string | undefined) => (v ?? '').trim();

/** Fields whose (trimmed) value differs from the initial values. NIP is immutable after creation. */
export function changedFields(values: PegawaiFormValues, initial: PegawaiFormValues): PegawaiFormField[] {
  return PEGAWAI_FORM_FIELDS.filter((field) => field !== 'nip' && norm(values[field]) !== norm(initial[field]));
}

/** POST body: required keys always, optional keys only when filled. */
export function buildCreatePayload(values: PegawaiFormValues): Record<string, unknown> {
  const body: Record<string, unknown> = {
    nip: norm(values.nip),
    nama: values.nama ?? '',
    role: values.role || 'Pegawai',
    statusKepegawaian: values.statusKepegawaian ?? '',
  };
  for (const field of PEGAWAI_FORM_FIELDS) {
    if (field in body || norm(values[field]) === '') continue;
    body[field] = toPayloadValue(field, values[field]);
  }
  return body;
}

/** PATCH body: only changed fields plus expectedUpdatedAt; `{}` when nothing changed. */
export function buildUpdatePayload(
  values: PegawaiFormValues,
  initial: PegawaiFormValues,
  expectedUpdatedAt: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const field of changedFields(values, initial)) body[field] = toPayloadValue(field, values[field]);
  if (Object.keys(body).length > 0) body.expectedUpdatedAt = expectedUpdatedAt;
  return body;
}

/** CPNS & PNS share the PNS pangkat list; PPPK has its own. */
export function pangkatFamily(status: string | null | undefined): 'PNS' | 'PPPK' | null {
  if (!status) return null;
  return status === 'PPPK' ? 'PPPK' : 'PNS';
}
