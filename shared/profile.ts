// Phase 3 API contract: profile, photo, reference data, employee dashboard,
// and employment-data change requests (owner decision #6).
// Shared by server (Hono) and client (React). Change both sides together.
import { z } from 'zod';
import {
  AGAMA,
  GOLONGAN_DARAH,
  JENIS_JABATAN,
  JENIS_KELAMIN,
  STATUS_KEPEGAWAIAN,
  STATUS_PENGAJUAN,
  STATUS_PERNIKAHAN,
  type Agama,
  type GolonganDarah,
  type JenisJabatan,
  type JenisKelamin,
  type StatusDokumen,
  type StatusKepegawaian,
  type StatusPengajuan,
  type StatusPernikahan,
} from './enums';
import { nikSchema, normalizePhone } from './validators';

// ---------------------------------------------------------------------------
// Reference data — GET /api/ref
// ---------------------------------------------------------------------------

export interface RefPangkat {
  kode: string; // 'III/a' | 'PPPK-IX'
  nama: string; // 'Penata Muda (III/a)' | 'Golongan IX'
  jenisAsn: 'PNS' | 'PPPK'; // CPNS uses the PNS list
}
export interface RefUnit {
  id: number;
  nama: string;
}
export interface RefPendidikan {
  kode: string;
  nama: string;
}
export interface RefJenisDokumen {
  id: string; // 'DOC-KTP'
  nama: string;
  kategori: string;
  /** Status kepegawaian for which this document is mandatory. */
  wajibUntuk: StatusKepegawaian[];
  maxSizeBytes: number;
}
export interface RefResponse {
  pangkat: RefPangkat[];
  unit: RefUnit[];
  pendidikan: RefPendidikan[];
  jenisDokumen: RefJenisDokumen[];
}

/** Pangkat options valid for a status (CPNS & PNS → PNS list; PPPK → PPPK list). */
export function pangkatForStatus(all: RefPangkat[], status: StatusKepegawaian | null): RefPangkat[] {
  if (!status) return all;
  const jenis = status === 'PPPK' ? 'PPPK' : 'PNS';
  return all.filter((p) => p.jenisAsn === jenis);
}

// ---------------------------------------------------------------------------
// Profile — GET /api/me/profile
// ---------------------------------------------------------------------------

/** Full employee profile. Dates: 'YYYY-MM-DD'. Phone: normalised '62…' digits. */
export interface Profile {
  id: number;
  nip: string;
  nama: string;
  role: 'Admin' | 'Pegawai';
  statusAkun: 'Aktif' | 'Nonaktif';
  fotoUrl: string | null;

  // Identitas (editable by the employee)
  nik: string | null;
  tempatLahir: string | null;
  tanggalLahir: string | null;
  jenisKelamin: JenisKelamin | null;
  agama: Agama | null;
  pendidikanKode: string | null;
  statusPernikahan: StatusPernikahan | null;
  golonganDarah: GolonganDarah | null;

  // Kontak (editable by the employee)
  noHp: string | null;
  email: string | null;
  alamat: string | null;

  // Kepegawaian (read-only for the employee; changed via pengajuan or by admin)
  statusKepegawaian: StatusKepegawaian | null;
  pangkatKode: string | null;
  tmtPangkat: string | null;
  jabatan: string | null;
  jenisJabatan: JenisJabatan | null;
  tmtJabatan: string | null;
  unitId: number | null;

  updatedAt: string; // ISO UTC
}

export interface ProfileResponse {
  profile: Profile;
  /** Labels of personal/contact fields still empty (same list used by the upload gate in Phase 4). */
  missingFields: string[];
  /** Pending change request, if any (at most one). */
  pengajuanAktif: Pengajuan | null;
}

// ---------------------------------------------------------------------------
// Profile update — PATCH /api/me/profile  (personal + contact ONLY)
// ---------------------------------------------------------------------------

/** Strict calendar check: '2026-02-31' is rejected (Date.parse would roll it over). */
function isRealDate(v: string): boolean {
  const [y, m, d] = v.split('-').map(Number) as [number, number, number];
  if (y < 1900 || y > 2100) return false;
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10) === v;
}

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Format tanggal harus YYYY-MM-DD.')
  .refine(isRealDate, 'Tanggal tidak valid.');

/** Today as 'YYYY-MM-DD' in UTC (string comparison is chronological for this format). */
const todayUtc = () => new Date().toISOString().slice(0, 10);

/** Empty string → null so the UI can clear optional fields. */
const nullableText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Maksimal ${max} karakter.`)
    .transform((v) => (v === '' ? null : v))
    .nullable();

const nullableEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z.union([z.enum(values), z.literal('').transform(() => null), z.null()]);

/**
 * Whitelist of fields an employee may change directly. `.strict()` rejects any
 * other key (e.g. employment fields) with 400 — they go through pengajuan.
 * All keys optional: PATCH semantics.
 */
export const updateProfileRequestSchema = z
  .object({
    nik: z.union([nikSchema, z.literal('').transform(() => null), z.null()]),
    tempatLahir: nullableText(100),
    tanggalLahir: z.union([
      isoDate.refine((v) => v <= todayUtc(), 'Tanggal lahir tidak boleh di masa depan.'),
      z.literal('').transform(() => null),
      z.null(),
    ]),
    jenisKelamin: nullableEnum(JENIS_KELAMIN),
    agama: nullableEnum(AGAMA),
    pendidikanKode: nullableText(16),
    statusPernikahan: nullableEnum(STATUS_PERNIKAHAN),
    golonganDarah: nullableEnum(GOLONGAN_DARAH),
    noHp: z
      .string()
      .trim()
      .transform((v, ctx) => {
        if (v === '') return null;
        const n = normalizePhone(v);
        if (!n) {
          ctx.addIssue({ code: 'custom', message: 'Nomor HP tidak valid. Contoh: 081234567890.' });
          return z.NEVER;
        }
        return n;
      })
      .nullable(),
    email: z.union([
      z.string().trim().toLowerCase().email('Format email tidak valid.').max(254),
      z.literal('').transform(() => null),
      z.null(),
    ]),
    alamat: nullableText(500),
  })
  .partial()
  .strict();
export type UpdateProfileRequest = z.input<typeof updateProfileRequestSchema>;

/**
 * Personal/contact fields required before document upload (legacy rule, PROJECT_CONTEXT §5.2).
 * Key = Profile field, value = Indonesian label shown to the user.
 */
export const REQUIRED_PROFILE_FIELDS = {
  noHp: 'Nomor HP / WhatsApp',
  email: 'Email',
  nik: 'NIK',
  tempatLahir: 'Tempat Lahir',
  tanggalLahir: 'Tanggal Lahir',
  jenisKelamin: 'Jenis Kelamin',
  agama: 'Agama',
  pendidikanKode: 'Pendidikan Terakhir',
  statusPernikahan: 'Status Pernikahan',
  alamat: 'Alamat',
} as const satisfies Partial<Record<keyof Profile, string>>;

export function missingProfileFields(p: Profile): string[] {
  return Object.entries(REQUIRED_PROFILE_FIELDS)
    .filter(([key]) => {
      const v = p[key as keyof Profile];
      return v === null || v === undefined || v === '';
    })
    .map(([, label]) => label);
}

// ---------------------------------------------------------------------------
// Photo — PUT /api/me/photo (multipart/form-data, field "file")
//         GET /api/pegawai/:id/photo (any signed-in user; private cache, ETag)
// ---------------------------------------------------------------------------

/** Client crops to 1:1 and encodes WebP (fallback JPEG) before upload. */
export const PHOTO_POLICY = {
  maxBytes: 2 * 1024 * 1024,
  /** Accepted after server-side magic-byte sniffing. */
  mimeTypes: ['image/webp', 'image/jpeg', 'image/png'] as const,
  outputSize: 512,
} as const;

export interface PhotoResponse {
  /** Cache-busted URL, e.g. /api/pegawai/12/photo?v=<etag> */
  fotoUrl: string;
}

// ---------------------------------------------------------------------------
// Employee dashboard — GET /api/me/dashboard
// ---------------------------------------------------------------------------

/** Derived status: 'Belum diunggah' = no arsip row. */
export type StatusDokumenView = StatusDokumen | 'Belum diunggah';

export interface DashboardDokumen {
  jenisDokumenId: string;
  nama: string;
  kategori: string;
  wajib: boolean;
  status: StatusDokumenView;
  /** Rejection note when status = Ditolak. */
  catatanAdmin: string | null;
  uploadedAt: string | null;
  verifiedAt: string | null;
}

export interface DashboardResponse {
  dokumen: {
    /** Mandatory docs for this employee's status kepegawaian. */
    wajibTotal: number;
    wajibTerverifikasi: number;
    /** Uploaded (any status except Belum diunggah). */
    wajibTersedia: number;
    /** Official % = round(wajibTerverifikasi / wajibTotal * 100); 0 when wajibTotal = 0. */
    persen: number;
    counts: Record<StatusDokumenView, number>;
    /** Ditolak first, then mandatory Belum diunggah, then Menunggu; max 5. */
    prioritas: DashboardDokumen[];
  };
  profil: {
    terisi: number;
    total: number;
    persen: number;
    missingFields: string[];
  };
  pengajuanAktif: Pengajuan | null;
  /** True when status kepegawaian is not set yet: document requirements cannot be computed. */
  statusKepegawaianKosong: boolean;
}

// ---------------------------------------------------------------------------
// Pengajuan perubahan data kepegawaian (owner decision #6)
// ---------------------------------------------------------------------------

/** Employment fields that can only change through a pengajuan (or by admin). */
export const KEPEGAWAIAN_FIELDS = [
  'statusKepegawaian',
  'pangkatKode',
  'tmtPangkat',
  'jabatan',
  'jenisJabatan',
  'tmtJabatan',
  'unitId',
] as const;
export type KepegawaianField = (typeof KEPEGAWAIAN_FIELDS)[number];

export const KEPEGAWAIAN_LABELS: Record<KepegawaianField, string> = {
  statusKepegawaian: 'Status Kepegawaian',
  pangkatKode: 'Pangkat / Golongan',
  tmtPangkat: 'TMT Pangkat',
  jabatan: 'Jabatan',
  jenisJabatan: 'Jenis Jabatan',
  tmtJabatan: 'TMT Jabatan',
  unitId: 'Unit Organisasi',
};

export type KepegawaianValue = string | number | null;

/** Stored in pengajuan_perubahan.perubahan (JSON). Only changed fields. */
export type PerubahanMap = Partial<Record<KepegawaianField, { lama: KepegawaianValue; baru: KepegawaianValue }>>;

export interface Pengajuan {
  id: number;
  pegawaiId: number;
  perubahan: PerubahanMap;
  alasan: string | null;
  status: StatusPengajuan;
  catatanAdmin: string | null;
  createdAt: string;
  reviewedAt: string | null;
  reviewedBy: { id: number; nama: string } | null;
}

/**
 * POST /api/me/pengajuan — submit the DESIRED values (only the fields to change).
 * Server computes `lama` from current data, drops unchanged fields, validates
 * pangkat vs status (PPPK ↔ PPPK list) and references. 409 CONFLICT if a pending
 * request already exists. 400 if nothing actually changes.
 */
export const createPengajuanRequestSchema = z
  .object({
    perubahan: z
      .object({
        statusKepegawaian: z.enum(STATUS_KEPEGAWAIAN),
        pangkatKode: z.string().trim().min(1).max(16).nullable(),
        tmtPangkat: isoDate.nullable(),
        jabatan: z.string().trim().min(1, 'Jabatan wajib diisi.').max(150).nullable(),
        jenisJabatan: z.enum(JENIS_JABATAN).nullable(),
        tmtJabatan: isoDate.nullable(),
        unitId: z.number().int().positive().nullable(),
      })
      .partial()
      .strict()
      .refine((v) => Object.keys(v).length > 0, 'Pilih minimal satu data yang ingin diubah.'),
    alasan: z.string().trim().min(10, 'Alasan minimal 10 karakter.').max(500, 'Maksimal 500 karakter.'),
  })
  .strict();
export type CreatePengajuanRequest = z.input<typeof createPengajuanRequestSchema>;

export interface PengajuanResponse {
  pengajuan: Pengajuan;
}
export interface PengajuanListResponse {
  items: Pengajuan[];
}

/** GET /api/admin/pengajuan?status=Menunggu|Disetujui|Ditolak|Dibatalkan (default Menunggu). */
export interface AdminPengajuanItem extends Pengajuan {
  pegawai: { id: number; nip: string; nama: string; statusKepegawaian: StatusKepegawaian | null };
  /** True when any `lama` no longer matches current data (profile changed since submission). */
  stale: boolean;
}
export interface AdminPengajuanListResponse {
  items: AdminPengajuanItem[];
  counts: Record<StatusPengajuan, number>;
}
export const adminPengajuanQuerySchema = z.object({
  status: z.enum(STATUS_PENGAJUAN).default('Menunggu'),
});

/**
 * POST /api/admin/pengajuan/:id/approve — applies `baru` values to pegawai atomically
 *   (only if status still 'Menunggu'; 409 CONFLICT otherwise) and audits PENGAJUAN_APPROVE.
 * POST /api/admin/pengajuan/:id/reject — body { catatan } (5–500 chars), audits PENGAJUAN_REJECT.
 * DELETE /api/me/pengajuan/:id — owner cancels a pending request → 'Dibatalkan'.
 *   Responds 200 PengajuanResponse; 409 CONFLICT if already processed, 404 if not the owner's.
 * PATCH /api/me/profile duplicate NIK → 409 CONFLICT (no `fields`; the client maps it to `nik`).
 */
export const reviewPengajuanRequestSchema = z.object({
  catatan: z.string().trim().max(500).optional(),
});
export const rejectPengajuanRequestSchema = z.object({
  catatan: z.string().trim().min(5, 'Catatan minimal 5 karakter.').max(500, 'Maksimal 500 karakter.'),
});
export type RejectPengajuanRequest = z.input<typeof rejectPengajuanRequestSchema>;
