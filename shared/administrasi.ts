// Phase 7: admin activity log, reference data and document-type configuration.
// Stable request/response contract used by Pages Functions and React.
import { z } from 'zod';
import { LOG_RESULT, STATUS_KEPEGAWAIAN, type LogResult, type StatusKepegawaian } from './enums';

// GET /api/admin/log?cursor=&q=&category=&result=&from=&to=
// Ordered ts DESC,id DESC, max 25 rows; cursor is opaque, filters preserved on next page.
// `q` searches description/action/actor_nama/actor_nip, literal substring, <=100 chars.
// category matches action prefixes from LOG_CATEGORIES, never arbitrary SQL.
export const LOG_CATEGORIES = ['auth', 'pegawai', 'dokumen', 'pengajuan', 'sistem', 'integrasi'] as const;
export type LogCategory = (typeof LOG_CATEGORIES)[number];
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => {
  const [y, m, d] = v.split('-').map(Number) as [number, number, number];
  if (y < 1900 || y > 2100) return false;
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10) === v;
}, 'Tanggal tidak valid.');
export const logQuerySchema = z.object({
  cursor: z.string().max(200).optional(),
  q: z.string().trim().max(100).optional(),
  category: z.enum(LOG_CATEGORIES).optional(),
  result: z.enum(LOG_RESULT).optional(),
  from: day.optional(),
  to: day.optional(),
}).refine((v) => !v.from || !v.to || v.from <= v.to, { path: ['to'], message: 'Tanggal akhir harus setelah tanggal awal.' });
export type LogQuery = z.input<typeof logQuerySchema>;
export interface LogItem {
  id: number;
  ts: string;
  actor: { id: number | null; nip: string | null; nama: string | null; role: string | null };
  action: string;
  targetType: string | null;
  targetId: string | null;
  description: string | null;
  result: LogResult;
}
export interface LogResponse { items: LogItem[]; nextCursor: string | null }

// GET /api/admin/ref — all rows, including inactive. Employee GET /api/ref remains active-only.
// POST /api/admin/ref/pangkat, PATCH /api/admin/ref/pangkat/:kode
// POST /api/admin/ref/unit, PATCH /api/admin/ref/unit/:id
// No hard deletes: deactivate with aktif=false, existing employee data remains intact.
// Pangkat kode and jenisAsn are immutable; unit id is server-generated. Unique names/codes
// -> 409 CONFLICT fields.nama/fields.kode; unknown key ->400; all mutations audit field names.
export interface AdminPangkat { kode: string; nama: string; jenisAsn: 'PNS' | 'PPPK'; urutan: number; aktif: boolean }
export interface AdminUnit { id: number; nama: string; aktif: boolean }
export interface AdminRefResponse {
  pangkat: AdminPangkat[];
  unit: AdminUnit[];
  pendidikan: { kode: string; nama: string; urutan: number }[]; // read-only in Phase 7
}
const nama = z.string().trim().min(2, 'Nama minimal 2 karakter.').max(150, 'Nama maksimal 150 karakter.');
export const createPangkatSchema = z.object({
  kode: z.string().trim().min(1).max(16, 'Kode maksimal 16 karakter.')
    .regex(/^[A-Za-z0-9/._-]+$/, 'Kode hanya boleh huruf, angka, / . _ -.')
    .refine((v) => v !== '.' && v !== '..', 'Kode tidak boleh berupa segmen . atau ..'),
  nama,
  jenisAsn: z.enum(['PNS', 'PPPK']),
  urutan: z.number().int().min(0).max(10_000),
  aktif: z.boolean().default(true),
}).strict();
export const updatePangkatSchema = createPangkatSchema.omit({ kode: true, jenisAsn: true })
  .extend({ aktif: z.boolean() }).partial().strict()
  .refine((v) => Object.keys(v).length > 0, 'Tidak ada perubahan.');
export const createUnitSchema = z.object({ nama, aktif: z.boolean().default(true) }).strict();
export const updateUnitSchema = createUnitSchema.extend({ aktif: z.boolean() }).partial().strict()
  .refine((v) => Object.keys(v).length > 0, 'Tidak ada perubahan.');
export type CreatePangkatRequest = z.input<typeof createPangkatSchema>;
export type UpdatePangkatRequest = z.input<typeof updatePangkatSchema>;
export type CreateUnitRequest = z.input<typeof createUnitSchema>;
export type UpdateUnitRequest = z.input<typeof updateUnitSchema>;

// GET /api/admin/jenis-dokumen — active+inactive, sorted urutan/nama/id.
// POST /api/admin/jenis-dokumen ->201 {item}; PATCH /:id ->200 {item}.
// jenis id immutable, safe ASCII (also part of R2 object keys). No hard deletes.
// Required matrix changes apply immediately, retroactively recalculating completeness
// for every employee of the selected status. UI must explain/confirm this effect.
// PATCH includes expectedUpdatedAt when available; stale ->409 fields.stale.
// Deactivating a type hides it from new uploads/completeness but does not erase archives.
export interface AdminJenisDokumen {
  id: string;
  nama: string;
  kategori: string;
  urutan: number;
  aktif: boolean;
  maxSizeBytes: number;
  wajibUntuk: StatusKepegawaian[];
  /** ISO-8601 UTC with milliseconds and Z (e.g. 2026-10-16T09:00:00.000Z), opaque CAS token. */
  updatedAt: string;
}
export interface AdminJenisResponse { items: AdminJenisDokumen[] }
const jenisFields = {
  nama,
  kategori: z.string().trim().min(2).max(100),
  urutan: z.number().int().min(0).max(10_000),
  aktif: z.boolean().default(true),
  maxSizeBytes: z.number().int().min(1024).max(5 * 1024 * 1024, 'Batas maksimal 5 MB.'),
  wajibUntuk: z.array(z.enum(STATUS_KEPEGAWAIAN)).max(3).refine((a) => new Set(a).size === a.length, 'Status wajib tidak boleh duplikat.'),
};
export const createJenisSchema = z.object({
  id: z.string().trim().min(3).max(64).regex(/^DOC-[A-Z0-9]+(?:-[A-Z0-9]+)*$/, 'ID harus DOC- diikuti huruf kapital/angka, boleh dipisah tanda -.'),
  ...jenisFields,
}).strict();
export const updateJenisSchema = z.object({
  ...jenisFields,
  // PATCH must never apply a create default to an omitted property.
  aktif: z.boolean(),
  expectedUpdatedAt: z.string().datetime().optional(),
}).partial().strict().refine((v) => Object.keys(v).some((k) => k !== 'expectedUpdatedAt'), 'Tidak ada perubahan.');
export type CreateJenisRequest = z.input<typeof createJenisSchema>;
export type UpdateJenisRequest = z.input<typeof updateJenisSchema>;
