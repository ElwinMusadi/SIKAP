// Phase 6 API contract: admin Master Data Pegawai (list, create, edit, account status,
// password reset, soft delete 7 days + restore, admin dashboard). Shared by server and client.
//
// Owner decisions applied:
//   #5 soft delete with 7-day retention (RETENTION.pegawaiSoftDeleteDays), admin can restore
//   #6 default password = last 6 digits of NIP, NOT forced to change; admin reset → default
import { z } from 'zod';
import { ROLES, STATUS_AKUN, STATUS_KEPEGAWAIAN, type Role, type StatusAkun, type StatusKepegawaian } from './enums';
import { kepegawaianFieldsSchema, profilFieldsSchema } from './profile';
import { nipSchema } from './validators';

// ---------------------------------------------------------------------------
// Completeness label (legacy parity: Admin.gs adminGetAllPegawai docLabel)
// ---------------------------------------------------------------------------
// 'Perlu Revisi'  — at least one MANDATORY document is Ditolak
// 'Lengkap'       — every mandatory document is Terverifikasi (and wajibTotal > 0)
// 'Belum Lengkap' — otherwise (including status kepegawaian not set: wajibTotal = 0)
export const KELENGKAPAN = ['Lengkap', 'Belum Lengkap', 'Perlu Revisi'] as const;
export type Kelengkapan = (typeof KELENGKAPAN)[number];

// ---------------------------------------------------------------------------
// List — GET /api/admin/pegawai
// ---------------------------------------------------------------------------
// Server-side filtering, sorting and paging (offset; small org, max 50 per page).
// `q` matches nama (case-insensitive substring) OR nip (substring).
// `belumUnggah=<jenisId>`: employees for whom that document is MANDATORY (per their status)
//   and who have no active (non-deleted) arsip row for it (PRD "siapa yang belum upload NPWP").
// `passwordDefault=true`: accounts still on the default password (is_default_password = 1).
// `terhapus=true`: ONLY soft-deleted employees still within retention (restore tab);
//   otherwise soft-deleted employees are always excluded.

// sort=kelengkapan (asc): Perlu Revisi → Belum Lengkap → Lengkap, then verified ratio, then nama
// (most actionable first); desc reverses the group/ratio order (the nama tie-breaker stays
// ascending). Every sort ends with `id` as a stable tie-breaker.
export const PEGAWAI_SORT = ['nama', 'nip', 'kelengkapan', 'updatedAt'] as const;
export type PegawaiSort = (typeof PEGAWAI_SORT)[number];
export const PAGE_SIZES = [15, 20, 30, 50] as const;

const boolParam = z
  .enum(['true', 'false'])
  .optional()
  .transform((v) => v === 'true');

export const pegawaiListQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  statusKepegawaian: z.enum(STATUS_KEPEGAWAIAN).optional(),
  statusAkun: z.enum(STATUS_AKUN).optional(),
  kelengkapan: z.enum(KELENGKAPAN).optional(),
  belumUnggah: z.string().trim().max(64).optional(),
  passwordDefault: boolParam,
  terhapus: boolParam,
  sort: z.enum(PEGAWAI_SORT).default('nama'),
  dir: z.enum(['asc', 'desc']).default('asc'),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .refine((n) => (PAGE_SIZES as readonly number[]).includes(n), 'Ukuran halaman tidak didukung.')
    .default(15),
});
export type PegawaiListQuery = z.input<typeof pegawaiListQuerySchema>;

export interface PegawaiListItem {
  id: number;
  nip: string;
  nama: string;
  role: Role;
  statusAkun: StatusAkun;
  statusKepegawaian: StatusKepegawaian | null;
  pangkatKode: string | null;
  jabatan: string | null;
  unitId: number | null;
  fotoUrl: string | null;
  isDefaultPassword: boolean;
  /** Locked by failed logins right now (locked_until > now). */
  terkunci: boolean;
  dokumen: {
    wajibTotal: number;
    wajibTerverifikasi: number;
    /** round(wajibTerverifikasi / wajibTotal * 100); 0 when wajibTotal = 0. */
    persen: number;
    kelengkapan: Kelengkapan;
    menunggu: number;
  };
  updatedAt: string;
  /** Only for terhapus=true rows. */
  deleted: { deletedAt: string; purgeAfter: string; deletedBy: { id: number; nama: string } | null } | null;
}

export interface PegawaiListResponse {
  items: PegawaiListItem[];
  page: number;
  pageSize: number;
  /** Rows matching the filters (for paging). */
  total: number;
  /** Totals ignoring filters (excluding soft-deleted): header summary. */
  summary: { total: number; aktif: number; nonaktif: number; passwordDefault: number; terhapus: number };
}

// ---------------------------------------------------------------------------
// Detail — GET /api/admin/pegawai/:id
// ---------------------------------------------------------------------------
// Full profile (same shape as Profile in shared/profile.ts) + account state. Soft-deleted
// employees return 404 here (use the terhapus list + restore). Documents are already served by
// GET /api/admin/pegawai/:id/documents (Phase 4).

export interface PegawaiDetailResponse {
  pegawai: import('./profile').Profile;
  akun: {
    isDefaultPassword: boolean;
    terkunci: boolean;
    lockedUntil: string | null;
    lastLoginAt: string | null;
    passwordChangedAt: string | null;
    sesiAktif: number;
  };
  pengajuanAktif: import('./profile').Pengajuan | null;
}

// ---------------------------------------------------------------------------
// Create — POST /api/admin/pegawai
// ---------------------------------------------------------------------------
// Creates pegawai + akun with the DEFAULT password (last 6 digits of NIP, is_default_password=1).
// NIP must be unique among ALL rows including soft-deleted ones (409 CONFLICT with a message that
// says whether the NIP belongs to a deleted employee that can be restored). NIK unique (409).
// Same reference validation as pengajuan: pangkat family must match status (CPNS/PNS → PNS
// list, PPPK → PPPK list), unit/pendidikan must exist and be active.
// Audit PEGAWAI_CREATE (no PII values). Response 201 PegawaiDetailResponse.

export const createPegawaiSchema = z
  .object({
    nip: nipSchema,
    nama: z.string().trim().min(3, 'Nama minimal 3 karakter.').max(150, 'Nama maksimal 150 karakter.'),
    role: z.enum(ROLES).default('Pegawai'),
    statusKepegawaian: z.enum(STATUS_KEPEGAWAIAN),
  })
  .extend(kepegawaianFieldsSchema.omit({ statusKepegawaian: true }).partial().shape)
  .extend(profilFieldsSchema.shape)
  .strict();
export type CreatePegawaiRequest = z.input<typeof createPegawaiSchema>;

// ---------------------------------------------------------------------------
// Update — PATCH /api/admin/pegawai/:id
// ---------------------------------------------------------------------------
// Admin edits identity, employment and contact data directly (no pengajuan). NIP is immutable
// (not in the schema; `.strict()` rejects it). Role changes allowed, BUT:
//   - an admin cannot change their OWN role (403); re-sending the current role is a no-op;
//   - the last remaining ACTIVE, non-deleted Admin cannot be demoted (409);
//     demoting an inactive admin is allowed.
// A role change revokes all sessions of that employee (privileges changed).
// Reference rules: pangkat and unit must be ACTIVE; pendidikan must exist (no active flag).
// `expectedUpdatedAt` (optional, recommended): optimistic concurrency — if pegawai.updated_at
// differs, 409 CONFLICT 'Data pegawai telah diubah. Muat ulang sebelum menyimpan.'
// If a pending pengajuan exists, it is NOT auto-closed; the admin list shows it as stale.
// Audit PEGAWAI_UPDATE with changed field NAMES only.

export const updatePegawaiSchema = z
  .object({
    nama: z.string().trim().min(3, 'Nama minimal 3 karakter.').max(150, 'Nama maksimal 150 karakter.'),
    role: z.enum(ROLES),
    expectedUpdatedAt: z.string().max(40),
  })
  .extend(kepegawaianFieldsSchema.shape)
  .extend(profilFieldsSchema.shape)
  .partial()
  .strict();
export type UpdatePegawaiRequest = z.input<typeof updatePegawaiSchema>;

// ---------------------------------------------------------------------------
// Account actions
// ---------------------------------------------------------------------------
// POST /api/admin/pegawai/:id/status    body { statusAkun }
//   Nonaktif → revokes ALL sessions of that employee in the same batch.
//   Self → 403 'Anda tidak dapat menonaktifkan akun sendiri.' Last active admin → 409.
//   Audit PEGAWAI_DEACTIVATE / PEGAWAI_REACTIVATE.
// POST /api/admin/pegawai/:id/reset-password
//   Sets password back to the DEFAULT (owner decision #6), is_default_password=1, clears
//   failed_attempts/locked_until, revokes all sessions. Self → 403 (use Pengaturan Akun).
//   Audit PASSWORD_RESET. Response AccountActionResponse.
// POST /api/admin/pegawai/:id/unlock
//   Clears failed_attempts/locked_until only (no password change). Audit ACCOUNT_UNLOCK.

export const setStatusAkunSchema = z.object({ statusAkun: z.enum(STATUS_AKUN) }).strict();
export type SetStatusAkunRequest = z.infer<typeof setStatusAkunSchema>;

export interface AccountActionResponse {
  item: PegawaiListItem;
  /** Sessions revoked by this action. */
  revokedSessions: number;
}

// ---------------------------------------------------------------------------
// Soft delete / restore (owner decision #5)
// ---------------------------------------------------------------------------
// DELETE /api/admin/pegawai/:id
//   Sets deleted_at, deleted_by, purge_after = now + 7 days; revokes all sessions; any pending
//   pengajuan → 'Dibatalkan'. Documents and R2 objects are untouched until the purge.
//   Self → 403. Last active admin → 409. Already deleted → 404.
//   Audit PEGAWAI_DELETE. Response { purgeAfter }.
//   Self → 403 'Anda tidak dapat menghapus akun sendiri.'
// POST /api/admin/pegawai/:id/restore
//   Only while purge_after > now: clears deleted_*; the account keeps its previous status_akun
//   and password; sessions were revoked so the employee logs in again. 404 when purged/unknown.
//   Audit PEGAWAI_RESTORE.
//   NIP and NIK stay UNIQUE across soft-deleted rows, so a deleted employee's NIP/NIK cannot be
//   reused by a new employee until the purge (≤ 7 days); create returns 409 meanwhile. This
//   guarantees a restore never conflicts.
// POST /api/admin/pegawai/:id/status and /unlock are idempotent (same state → 200, no audit);
// reset-password is not (new hash, sessions revoked, audited each time).
// The permanent purge (D1 rows + every R2 object of the employee) is done by the Phase 7 cron.

export interface DeletePegawaiResponse {
  purgeAfter: string;
}

// ---------------------------------------------------------------------------
// Admin dashboard — GET /api/admin/dashboard
// ---------------------------------------------------------------------------

export interface AdminDashboardResponse {
  pegawai: {
    total: number;
    aktif: number;
    nonaktif: number;
    perStatus: Record<StatusKepegawaian | 'Belum diisi', number>;
    passwordDefault: number;
  };
  dokumen: {
    /** Pending verification queue size. */
    menunggu: number;
    /** Institution-wide mandatory completeness: Σ terverifikasi / Σ wajib over active employees. */
    persenKelengkapan: number;
    perKelengkapan: Record<Kelengkapan, number>;
  };
  pengajuanMenunggu: number;
  /** Latest 7 audit entries (description only, no PII values). */
  aktivitasTerbaru: { id: number; ts: string; actorNama: string | null; action: string; description: string | null; result: string }[];
}
