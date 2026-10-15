// Single source of truth for enum values used by D1 CHECK constraints,
// server validation, and UI select options. Keep in sync with migrations/0001_init.sql.

export const ROLES = ['Admin', 'Pegawai'] as const;
export type Role = (typeof ROLES)[number];

export const STATUS_AKUN = ['Aktif', 'Nonaktif'] as const;
export type StatusAkun = (typeof STATUS_AKUN)[number];

export const STATUS_KEPEGAWAIAN = ['PNS', 'CPNS', 'PPPK'] as const;
export type StatusKepegawaian = (typeof STATUS_KEPEGAWAIAN)[number];

export const JENIS_JABATAN = ['Fungsional', 'Pelaksana', 'Struktural'] as const;
export type JenisJabatan = (typeof JENIS_JABATAN)[number];

export const JENIS_KELAMIN = ['Laki-laki', 'Perempuan'] as const;
export type JenisKelamin = (typeof JENIS_KELAMIN)[number];

export const AGAMA = ['Kristen Protestan', 'Kristen Katholik', 'Islam', 'Hindu', 'Buddha', 'Konghucu'] as const;
export type Agama = (typeof AGAMA)[number];

export const STATUS_PERNIKAHAN = ['Belum Menikah', 'Menikah', 'Cerai'] as const;
export type StatusPernikahan = (typeof STATUS_PERNIKAHAN)[number];

export const GOLONGAN_DARAH = ['A', 'B', 'AB', 'O', 'Tidak Tahu'] as const;
export type GolonganDarah = (typeof GOLONGAN_DARAH)[number];

/** Stored document status. "Belum diunggah" = no arsip row (derived, never stored). */
export const STATUS_DOKUMEN = ['Menunggu', 'Terverifikasi', 'Ditolak'] as const;
export type StatusDokumen = (typeof STATUS_DOKUMEN)[number];

export const STATUS_PENGAJUAN = ['Menunggu', 'Disetujui', 'Ditolak', 'Dibatalkan'] as const;
export type StatusPengajuan = (typeof STATUS_PENGAJUAN)[number];

export const LOG_RESULT = ['SUCCESS', 'FAILURE', 'WARNING', 'PARTIAL'] as const;
export type LogResult = (typeof LOG_RESULT)[number];

/** Retention policy (owner decisions #4 and #5). */
export const RETENTION = {
  documentVersionDays: 3,
  documentSoftDeleteDays: 3,
  pegawaiSoftDeleteDays: 7,
} as const;

/** Auth policy (owner decisions #2 and #6). */
export const AUTH_POLICY = {
  pbkdf2Iterations: 10_000,
  maxFailedAttempts: 5,
  lockoutMinutes: 15,
  sessionTtlHours: 12,
  /** Do not write `last_seen_at` more often than this (saves D1 writes). */
  sessionTouchIntervalMinutes: 5,
} as const;
