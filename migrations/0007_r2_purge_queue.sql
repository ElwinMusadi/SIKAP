-- Phase 7: retention purge, R2 delete queue.
--
-- The purge cron (server/services/purge.ts) removes expired D1 rows with SQL-guarded
-- DELETEs and, in the SAME db.batch() (one transaction), enqueues the EXACT R2 keys of
-- the rows those guards remove. R2 objects are deleted later by drainPurgeQueue(), which
-- re-checks that no row still references a key before deleting it. Never prefix deletes.
--
-- Columns
--   bucket           logical binding: 'FILES' (documents/photos, drained by purge.ts) or
--                    'BACKUPS' (owned/drained by the backup job; purge.ts never touches it).
--   source           free-form producer tag, e.g. 'VERSI_EXPIRED', 'ARSIP_EXPIRED',
--                    'PEGAWAI_EXPIRED', 'BACKUP_EXPIRED' (no CHECK: producers may add tags).
--   attempts         failed delete attempts (backoff input); claims do not consume attempts.
--   lease_token/lease_until  atomic claim, same pattern as notifikasi_outbox (0005).
--   next_attempt_at  earliest retry time after a failure; NULL = due now.
--   last_error       safe constant error code only (never provider/exception text).
--
-- Producers insert with ON CONFLICT(bucket, object_key) so a key is queued at most once.

CREATE TABLE r2_purge_queue (
  object_key       TEXT NOT NULL,
  bucket           TEXT NOT NULL CHECK (bucket IN ('FILES','BACKUPS')),
  source           TEXT NOT NULL,
  enqueued_at      TEXT NOT NULL,
  attempts         INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_token      TEXT,
  lease_until      TEXT,
  next_attempt_at  TEXT,
  last_error       TEXT,
  PRIMARY KEY (bucket, object_key)
);

-- Claim scan: per bucket in enqueue order, filter columns covered.
CREATE INDEX idx_r2_purge_queue_due
  ON r2_purge_queue(bucket, enqueued_at, object_key, next_attempt_at, lease_until);

-- Reference checks (drain) and key lookups: every row that may hold a FILES key.
CREATE INDEX idx_arsip_r2_key   ON arsip_dokumen(r2_key);
CREATE INDEX idx_versi_r2_key   ON arsip_dokumen_versi(r2_key);
CREATE INDEX idx_pegawai_foto   ON pegawai(foto_r2_key) WHERE foto_r2_key IS NOT NULL;

-- Employee purge deletes the purged employee's document history by pegawai_id (so a
-- reused numeric pegawai id never inherits it; see 0004).
CREATE INDEX idx_riwayat_pegawai ON arsip_dokumen_riwayat(pegawai_id) WHERE pegawai_id IS NOT NULL;
