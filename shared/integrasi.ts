// Integration API: read-only /api/v1 for other applications (first: PINTU) and the Admin
// screens that manage their API keys. Plan and owner decisions: docs/RENCANA-API-INTEGRASI.md.
//
// Owner decisions applied (22 Oct 2026):
//   #1 search results carry no contact data; email + no HP only in the per-NIP detail,
//      and every detail read is written to the activity log (#7)
//   #2 only active employees (not soft-deleted, status_akun = 'Aktif')
//   #5 every key expires: 90 / 180 / 365 days, default 365
//   #6 deleting a key revokes it immediately; the audit trail stays in log_aktivitas
//   #8 60 requests per minute per key
import { z } from 'zod';
import { STATUS_KEPEGAWAIAN, type JenisJabatan, type StatusKepegawaian } from './enums';

// ---------------------------------------------------------------------------
// Keys and scopes
// ---------------------------------------------------------------------------

export const IZIN_API = ['pegawai:baca'] as const;
export type IzinApi = (typeof IZIN_API)[number];

export const IZIN_API_LABELS: Record<IzinApi, string> = {
  'pegawai:baca': 'Baca data pegawai',
};

/** `skp_<id_publik: 12 hex>_<secret: 32 random bytes, base64url>`; the secret may contain '_'. */
export const API_KEY_PATTERN = /^skp_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;

export const MASA_BERLAKU_HARI = [90, 180, 365] as const;
export type MasaBerlakuHari = (typeof MASA_BERLAKU_HARI)[number];
export const MASA_BERLAKU_BAWAAN: MasaBerlakuHari = 365;

/** Per key, fixed window (decision #8). */
export const API_RATE_LIMIT = { requests: 60, windowSeconds: 60 } as const;
/** Failed authentications per client IP; only the first of each window is logged. */
export const API_AUTH_FAIL_LIMIT = { attempts: 20, windowMinutes: 15 } as const;

// POST /api/admin/kunci-api
export const createKunciApiSchema = z
  .object({
    nama: z.string().trim().min(1, 'Nama klien wajib diisi.').max(60, 'Nama klien maksimal 60 karakter.'),
    keterangan: z
      .string()
      .trim()
      .max(200, 'Keterangan maksimal 200 karakter.')
      .nullish()
      .transform((v) => (v ? v : null)),
    izin: z
      .array(z.enum(IZIN_API, { message: 'Izin tidak dikenal.' }))
      .min(1, 'Pilih minimal satu izin.')
      .max(IZIN_API.length)
      .transform((list) => IZIN_API.filter((i) => list.includes(i))),
    masaBerlakuHari: z
      .number()
      .int()
      .refine((n) => (MASA_BERLAKU_HARI as readonly number[]).includes(n), 'Masa berlaku harus 90, 180, atau 365 hari.')
      .default(MASA_BERLAKU_BAWAAN),
  })
  .strict();
export type CreateKunciApiRequest = z.input<typeof createKunciApiSchema>;

/** Never contains the key or its hash. */
export interface KunciApiItem {
  id: number;
  /** Shown as `skp_<idPublik>…` so admins can match a key to a configuration. */
  idPublik: string;
  nama: string;
  keterangan: string | null;
  izin: IzinApi[];
  createdAt: string;
  createdBy: { id: number | null; nama: string | null };
  expiresAt: string;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
}

export interface KunciApiListResponse {
  items: KunciApiItem[];
}

/** `kunci` is returned exactly once, by the create call. */
export interface KunciApiCreateResponse {
  item: KunciApiItem;
  kunci: string;
}

// ---------------------------------------------------------------------------
// GET /api/v1/ping
// ---------------------------------------------------------------------------

export interface V1PingResponse {
  klien: string;
  idKunci: string;
  izin: IzinApi[];
  kedaluwarsa: string;
}

// ---------------------------------------------------------------------------
// GET /api/v1/pegawai?q=&statusKepegawaian=&unitId=&page=&pageSize=
// ---------------------------------------------------------------------------
// Active employees only, ordered by nama. `q` matches nama (case-insensitive substring)
// or NIP (substring), at least 2 characters. Unknown query parameters are ignored; a key
// passed in the query string is never read.

export const V1_PAGE_SIZES = [10, 20, 50] as const;

export const v1PegawaiQuerySchema = z.object({
  q: z
    .string()
    .trim()
    .max(100, 'Kata kunci maksimal 100 karakter.')
    .optional()
    .transform((v) => (v ? v : undefined))
    .refine((v) => v === undefined || v.length >= 2, 'Kata kunci minimal 2 karakter.'),
  statusKepegawaian: z.enum(STATUS_KEPEGAWAIAN).optional(),
  unitId: z.coerce.number().int().min(1).max(1_000_000).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .refine((n) => (V1_PAGE_SIZES as readonly number[]).includes(n), 'Ukuran halaman harus 10, 20, atau 50.')
    .default(20),
});
export type V1PegawaiQuery = z.input<typeof v1PegawaiQuerySchema>;

/** Search result: identification only, never contact or personal data (decision #1). */
export interface V1PegawaiItem {
  nip: string;
  nama: string;
  statusKepegawaian: StatusKepegawaian | null;
  pangkat: { kode: string; nama: string } | null;
  jabatan: string | null;
  jenisJabatan: JenisJabatan | null;
  unit: { id: number; nama: string } | null;
  /** `pegawai.updated_at`, ISO UTC. */
  diperbarui: string;
}

export interface V1PegawaiListResponse {
  items: V1PegawaiItem[];
  page: number;
  pageSize: number;
  total: number;
}

// GET /api/v1/pegawai/{nip}: one active employee, logged as API_PEGAWAI_READ.
export interface V1PegawaiDetail extends V1PegawaiItem {
  email: string | null;
  /** SIKAP format: '62…' without '+'. */
  noHp: string | null;
}

/** Exact JSON keys per projection; tests fail if anything else leaks out. */
export const V1_PEGAWAI_ITEM_KEYS = [
  'nip', 'nama', 'statusKepegawaian', 'pangkat', 'jabatan', 'jenisJabatan', 'unit', 'diperbarui',
] as const;
export const V1_PEGAWAI_DETAIL_KEYS = [...V1_PEGAWAI_ITEM_KEYS, 'email', 'noHp'] as const;
