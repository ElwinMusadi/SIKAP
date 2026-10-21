// Pinned isolated UAT identifiers shared by the staging tools. Pure data: no imports, no I/O.
export const UAT_ACCOUNT = '04b8b2073be2f1aa21fc6489e0db36f6';
export const UAT_DB = '9d6ca598-057e-4297-9b8c-3ce789c5ab14';
// Every application table except reference/seed tables (ref_*, jenis_dokumen*, pengaturan).
// Shared by the fixture empty-target guard and the read-only remote preflight counts.
export const APP_TABLES = Object.freeze([
  'pegawai', 'akun', 'sesi', 'rate_limit', 'arsip_dokumen', 'arsip_dokumen_versi', 'arsip_dokumen_riwayat',
  'pengajuan_perubahan', 'log_aktivitas', 'notifikasi_outbox', 'backup_job', 'backup_part', 'r2_purge_queue',
]);
