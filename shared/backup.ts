// Phase 7 logical backup contract. This is a resumable export, NOT a point-in-time
// snapshot and NOT a copy of R2 file bytes. Use D1 Time Travel / wrangler d1 export for
// transaction-consistent disaster recovery and retain a separate file backup if required.
// Secrets PASSWORD_PEPPER / SETTINGS_ENC_KEY are never exported; recovering password hashes
// and encrypted provider tokens requires their separately protected original keys.
export const BACKUP_TABLES = [
  'ref_pangkat_golongan', 'ref_unit_organisasi', 'ref_pendidikan', 'jenis_dokumen',
  'jenis_dokumen_wajib', 'pegawai', 'akun', 'arsip_dokumen', 'arsip_dokumen_versi',
  'arsip_dokumen_riwayat', 'pengajuan_perubahan', 'pengaturan', 'log_aktivitas',
] as const;
// No session tokens, login throttles, notification recipient queues, purge queues or leases.
// No integration API keys (kunci_api): a restore must never revive a deleted key.
export type BackupTable = (typeof BACKUP_TABLES)[number];
export type BackupStatus = 'RUNNING' | 'DONE' | 'FAILED';
export interface BackupPart {
  sequence: number; // positive 1-based integer (first part is 1)
  table: BackupTable;
  rows: number;
  bytes: number;
  /** Admin-only same-origin URL, not a public R2 URL. */
  downloadUrl: string;
}
export interface BackupJob {
  id: string; // UUID; object prefix is unique even if employee/database integer ids are reused
  status: BackupStatus;
  startedAt: string;
  finishedAt: string | null;
  /** 30-day retention; unavailable once expiry is reached. */
  purgeAfter: string;
  startedBy: { id: number; nama: string | null } | null;
  currentTable: BackupTable | null;
  tablesCompleted: number;
  totalTables: number;
  rowCount: number;
  byteCount: number;
  errorCode: string | null; // safe controlled code, never raw exception text
  consistent: false;
  includesFileBytes: false;
  parts: BackupPart[];
}
export interface BackupListResponse {
  configured: boolean;
  jobs: BackupJob[]; // newest 20 unexpired jobs
}
export interface BackupJobResponse { job: BackupJob }
// Admin only, CSRF protected:
// POST /api/admin/backup ->201 BackupJobResponse (one unfinished job at a time; else409).
// POST /api/admin/backup/:id/step ->200 BackupJobResponse (one bounded chunk per request).
//   Chunk: <=200 rows of one table by rowid, byte cap, with a lease. Client repeats until
//   DONE or FAILED. Leaving the page pauses manual export; cron may resume it later.
// GET /api/admin/backup ->200 BackupListResponse (configured:false instead of500 if unbound).
// GET /api/admin/backup/:id ->200 BackupJobResponse.
// GET /api/admin/backup/:id/parts/:sequence ->stream NDJSON attachment, private/no-store/nosniff.
// GET /api/admin/backup/:id/manifest ->stream JSON attachment for DONE jobs.
// POST/step without BACKUPS binding ->503 code INTERNAL_ERROR, controlled message
//   'Penyimpanan backup belum dikonfigurasi.' (no new error code required).
// Overall job caps: 50MB or 500 parts; exceeding ->FAILED with BACKUP_SIZE_LIMIT.
// Manifest must state consistent:false, includesFileBytes:false, excludedTables, counts,
// schema/migration identifiers and that exported R2 keys/checksums are inventory only.
// Manual restore/import is intentionally absent: do not write archived hashes into a live DB
// without a separately reviewed recovery procedure.
