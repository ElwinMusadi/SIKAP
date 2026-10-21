-- Phase 7: resumable private logical backup (contract: shared/backup.ts).
--
-- A backup job exports the whitelisted tables (BACKUP_TABLES) in bounded chunks of
-- <= 200 rows by rowid into NDJSON parts stored in the private BACKUPS R2 bucket under
-- backups/{jobId}/{seq}-{uuid}.ndjson. It is NOT a point-in-time snapshot
-- (consistent:false): every chunk is read in its own transaction.
--
-- high_water_json: {table: max(rowid)} captured atomically when the job is created. A
-- table is exported only up to that rowid, so append-only tables (log_aktivitas, which
-- receives the backup's own audit rows) can never keep a job running forever.
--
-- Cursor: (tbl_idx, last_rowid, part_seq). Every step claims a 60 s lease
-- (lease_token/lease_until, real clock) with one atomic UPDATE … RETURNING, writes at most
-- one R2 part, then inserts the part row and advances the cursor in one batch guarded by
-- lease_token AND the previous cursor (compare-and-swap), and clears the lease. A
-- duplicate or late step can therefore never insert a second part for a sequence.
--
-- manifest_json is written once when the job becomes DONE (small: schema SQL, migration
-- names, per-table counts and the part list with sha256 — no R2 keys, no file bytes).
--
-- Retention: purge_after = started_at + 30 days. purgeBackupJobs() enqueues the exact part
-- keys into r2_purge_queue (bucket 'BACKUPS') and deletes the job (parts cascade) in one
-- batch. A worker crash between R2 put and the D1 batch can leave an unreferenced part
-- object; names are unique per attempt, it is never served, and an R2 lifecycle rule on
-- the backups/ prefix (> 30 days) removes it.

CREATE TABLE backup_job (
  id              TEXT PRIMARY KEY CHECK (length(id) = 36),       -- UUID
  status          TEXT NOT NULL CHECK (status IN ('RUNNING','DONE','FAILED')),
  started_at      TEXT NOT NULL,
  started_by      INTEGER REFERENCES pegawai(id) ON DELETE SET NULL, -- NULL = system/cron or purged admin; never reuse identity
  finished_at     TEXT,
  purge_after     TEXT NOT NULL,
  tbl_idx         INTEGER NOT NULL DEFAULT 0 CHECK (tbl_idx >= 0),
  last_rowid      INTEGER NOT NULL DEFAULT 0,
  part_seq        INTEGER NOT NULL DEFAULT 0 CHECK (part_seq >= 0), -- parts written; next = part_seq + 1
  row_count       INTEGER NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  byte_count      INTEGER NOT NULL DEFAULT 0 CHECK (byte_count >= 0),
  lease_token     TEXT,
  lease_until     TEXT,
  error_code      TEXT,                                            -- controlled code only, never exception text
  high_water_json TEXT NOT NULL CHECK (json_valid(high_water_json)),
  manifest_json   TEXT CHECK (manifest_json IS NULL OR json_valid(manifest_json)),
  CHECK ((status = 'RUNNING') = (finished_at IS NULL)),
  CHECK (status <> 'DONE' OR manifest_json IS NOT NULL),
  CHECK (status <> 'FAILED' OR error_code IS NOT NULL)
);
-- At most one unfinished job (race-safe backstop for the 409 check).
CREATE UNIQUE INDEX uq_backup_job_running ON backup_job(status) WHERE status = 'RUNNING';
CREATE INDEX idx_backup_job_started ON backup_job(started_at DESC, id);
CREATE INDEX idx_backup_job_purge ON backup_job(purge_after);

CREATE TABLE backup_part (
  job_id      TEXT NOT NULL REFERENCES backup_job(id) ON DELETE CASCADE,
  sequence    INTEGER NOT NULL CHECK (sequence >= 1),
  table_name  TEXT NOT NULL,
  first_rowid INTEGER NOT NULL,
  last_rowid  INTEGER NOT NULL,
  object_key  TEXT NOT NULL UNIQUE,
  rows        INTEGER NOT NULL CHECK (rows >= 1),
  bytes       INTEGER NOT NULL CHECK (bytes >= 1),
  sha256      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (job_id, sequence)
);
