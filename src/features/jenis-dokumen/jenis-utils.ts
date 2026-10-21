import { STATUS_KEPEGAWAIAN, type StatusKepegawaian } from '@shared/enums';
import {
  createJenisSchema,
  updateJenisSchema,
  type AdminJenisDokumen,
  type CreateJenisRequest,
  type UpdateJenisRequest,
} from '@shared/administrasi';

const MB = 1024 * 1024;

export interface JenisForm {
  id: string;
  nama: string;
  kategori: string;
  urutan: string;
  maxMb: string;
  aktif: boolean;
  wajibUntuk: StatusKepegawaian[];
}

export type JenisFormErrors = Partial<Record<keyof JenisForm | 'form', string>>;

export function bytesToMb(bytes: number): string {
  return String(Math.round((bytes / MB) * 100) / 100);
}

export function formatMaxSize(bytes: number): string {
  return `${bytesToMb(bytes).replace('.', ',')} MB`;
}

export function emptyJenisForm(nextUrutan = 0): JenisForm {
  return { id: 'DOC-', nama: '', kategori: '', urutan: String(nextUrutan), maxMb: '2', aktif: true, wajibUntuk: [] };
}

export function jenisToForm(item: AdminJenisDokumen): JenisForm {
  return {
    id: item.id,
    nama: item.nama,
    kategori: item.kategori,
    urutan: String(item.urutan),
    maxMb: bytesToMb(item.maxSizeBytes),
    aktif: item.aktif,
    wajibUntuk: sortStatuses(item.wajibUntuk),
  };
}

export function sortStatuses(list: readonly StatusKepegawaian[]): StatusKepegawaian[] {
  return STATUS_KEPEGAWAIAN.filter((s) => list.includes(s));
}

function sameStatuses(a: readonly StatusKepegawaian[], b: readonly StatusKepegawaian[]): boolean {
  const x = sortStatuses(a);
  const y = sortStatuses(b);
  return x.length === y.length && x.every((s, i) => s === y[i]);
}

/** Server/schema field name -> form field name. */
function formField(path: string): keyof JenisForm | 'form' {
  if (path === 'maxSizeBytes') return 'maxMb';
  if (path === 'id' || path === 'nama' || path === 'kategori' || path === 'urutan' || path === 'aktif' || path === 'wajibUntuk') return path;
  return 'form';
}

export function mapFieldErrors(fields: Record<string, string>): JenisFormErrors {
  const errors: JenisFormErrors = {};
  for (const [key, message] of Object.entries(fields)) errors[formField(key)] ??= message;
  return errors;
}

function parseNumber(value: string): number {
  return value.trim() === '' ? Number.NaN : Number(value.replace(',', '.'));
}

function common(form: JenisForm, errors: JenisFormErrors) {
  const urutan = parseNumber(form.urutan);
  const mb = parseNumber(form.maxMb);
  if (!Number.isInteger(urutan)) errors.urutan = 'Urutan harus berupa bilangan bulat.';
  if (!Number.isFinite(mb) || mb < 1 || mb > 5) errors.maxMb = 'Ukuran maksimal 1–5 MB.';
  return {
    nama: form.nama.trim(),
    kategori: form.kategori.trim(),
    urutan,
    maxSizeBytes: Math.round(mb * MB),
    aktif: form.aktif,
    wajibUntuk: sortStatuses(form.wajibUntuk),
  };
}

type Result<T> = { ok: true; data: T } | { ok: false; errors: JenisFormErrors };

function issuesToErrors(issues: readonly { path: readonly PropertyKey[]; message: string }[], errors: JenisFormErrors): JenisFormErrors {
  for (const issue of issues) errors[formField(String(issue.path[0] ?? 'form'))] ??= issue.message;
  return errors;
}

export function buildCreatePayload(form: JenisForm): Result<CreateJenisRequest> {
  const errors: JenisFormErrors = {};
  const body = { id: form.id.trim().toUpperCase(), ...common(form, errors) };
  const parsed = createJenisSchema.safeParse(body);
  if (!parsed.success) issuesToErrors(parsed.error.issues, errors);
  if (Object.keys(errors).length > 0 || !parsed.success) return { ok: false, errors };
  return { ok: true, data: parsed.data };
}

/** Only changed fields are sent, always with expectedUpdatedAt for optimistic concurrency. */
export function buildUpdatePayload(form: JenisForm, original: AdminJenisDokumen): Result<UpdateJenisRequest> {
  const errors: JenisFormErrors = {};
  const next = common(form, errors);
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const body: UpdateJenisRequest = { expectedUpdatedAt: original.updatedAt };
  if (next.nama !== original.nama) body.nama = next.nama;
  if (next.kategori !== original.kategori) body.kategori = next.kategori;
  if (next.urutan !== original.urutan) body.urutan = next.urutan;
  if (next.maxSizeBytes !== original.maxSizeBytes) body.maxSizeBytes = next.maxSizeBytes;
  if (next.aktif !== original.aktif) body.aktif = next.aktif;
  if (!sameStatuses(next.wajibUntuk, original.wajibUntuk)) body.wajibUntuk = next.wajibUntuk;
  if (Object.keys(body).length === 1) return { ok: false, errors: { form: 'Tidak ada perubahan.' } };
  const parsed = updateJenisSchema.safeParse(body);
  if (!parsed.success) return { ok: false, errors: issuesToErrors(parsed.error.issues, errors) };
  // Send exactly the validated diff so PATCH carries only fields the admin changed.
  return { ok: true, data: body };
}

/** Changes whose effect is retroactive for every employee and therefore need explicit confirmation. */
export function impactfulChanges(form: JenisForm, original: AdminJenisDokumen | null): { wajib: boolean; aktif: boolean } {
  if (!original) return { wajib: form.wajibUntuk.length > 0, aktif: false };
  return { wajib: !sameStatuses(form.wajibUntuk, original.wajibUntuk), aktif: form.aktif !== original.aktif };
}

export function isFormDirty(form: JenisForm, initial: JenisForm): boolean {
  return (
    form.id !== initial.id ||
    form.nama !== initial.nama ||
    form.kategori !== initial.kategori ||
    form.urutan !== initial.urutan ||
    form.maxMb !== initial.maxMb ||
    form.aktif !== initial.aktif ||
    !sameStatuses(form.wajibUntuk, initial.wajibUntuk)
  );
}
