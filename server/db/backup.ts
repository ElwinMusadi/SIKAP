// SQL helpers for the resumable logical backup (migration 0008, contract shared/backup.ts).
// Table names are interpolated ONLY from the BACKUP_TABLES constant (never from a request),
// and always double-quoted. Every value is a bound parameter.

import { BACKUP_TABLES, type BackupTable } from '../../shared/backup';

export const BACKUP_PART_MAX_ROWS = 200;

export interface BackupJobRow {
  id: string;
  status: 'RUNNING' | 'DONE' | 'FAILED';
  started_at: string;
  started_by: number | null;
  started_by_nama: string | null;
  finished_at: string | null;
  purge_after: string;
  tbl_idx: number;
  last_rowid: number;
  part_seq: number;
  row_count: number;
  byte_count: number;
  error_code: string | null;
}

export interface BackupPartRow {
  job_id: string;
  sequence: number;
  table_name: string;
  first_rowid: number;
  last_rowid: number;
  rows: number;
  bytes: number;
  sha256: string;
}

/** State returned by a successful lease claim: the cursor every guarded write compares against. */
export interface ClaimRow {
  id: string;
  started_at: string;
  tbl_idx: number;
  last_rowid: number;
  part_seq: number;
  row_count: number;
  byte_count: number;
  high_water_json: string;
}

/** The cursor a guarded write must still find (compare-and-swap with the lease token). */
export interface Cursor {
  token: string;
  tblIdx: number;
  lastRowid: number;
  partSeq: number;
}

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function isBackupTable(name: string): name is BackupTable {
  return (BACKUP_TABLES as readonly string[]).includes(name);
}

const JOB_COLUMNS = `j.id, j.status, j.started_at, j.started_by, p.nama AS started_by_nama, j.finished_at,
  j.purge_after, j.tbl_idx, j.last_rowid, j.part_seq, j.row_count, j.byte_count, j.error_code`;

const MAX_LIST_JOBS = 20;
const LIST_JOB_IDS = `SELECT id FROM backup_job WHERE purge_after > ?1 ORDER BY started_at DESC, id DESC LIMIT ${MAX_LIST_JOBS}`;

/** Newest unexpired jobs (one statement of the list batch). */
export function selectRecentJobs(db: D1Database, nowIso: string): D1PreparedStatement {
  return db
    .prepare(
      `SELECT ${JOB_COLUMNS} FROM backup_job j LEFT JOIN pegawai p ON p.id = j.started_by
        WHERE j.purge_after > ?1 ORDER BY j.started_at DESC, j.id DESC LIMIT ${MAX_LIST_JOBS}`,
    )
    .bind(nowIso);
}

/** Parts of exactly the jobs selectRecentJobs returns (same batch => same snapshot, no N+1). */
export function selectRecentParts(db: D1Database, nowIso: string): D1PreparedStatement {
  return db
    .prepare(
      `SELECT job_id, sequence, table_name, first_rowid, last_rowid, rows, bytes, sha256 FROM backup_part
        WHERE job_id IN (${LIST_JOB_IDS}) ORDER BY job_id, sequence`,
    )
    .bind(nowIso);
}

export function selectJob(db: D1Database, id: string, nowIso: string): D1PreparedStatement {
  return db
    .prepare(
      `SELECT ${JOB_COLUMNS} FROM backup_job j LEFT JOIN pegawai p ON p.id = j.started_by
        WHERE j.id = ?1 AND j.purge_after > ?2`,
    )
    .bind(id, nowIso);
}

export function selectParts(db: D1Database, id: string): D1PreparedStatement {
  return db
    .prepare(
      `SELECT job_id, sequence, table_name, first_rowid, last_rowid, rows, bytes, sha256 FROM backup_part
        WHERE job_id = ?1 ORDER BY sequence`,
    )
    .bind(id);
}

/** Part metadata for a download: only for an existing, unexpired job. */
export function selectPartForDownload(db: D1Database, id: string, sequence: number, nowIso: string): D1PreparedStatement {
  return db
    .prepare(
      `SELECT bp.table_name, bp.object_key, bp.bytes, j.started_at FROM backup_part bp
         JOIN backup_job j ON j.id = bp.job_id
        WHERE bp.job_id = ?1 AND bp.sequence = ?2 AND j.purge_after > ?3`,
    )
    .bind(id, sequence, nowIso);
}

export function selectManifest(db: D1Database, id: string, nowIso: string): D1PreparedStatement {
  return db
    .prepare(`SELECT status, started_at, manifest_json FROM backup_job WHERE id = ?1 AND purge_after > ?2`)
    .bind(id, nowIso);
}

export function partKeyReferenced(db: D1Database, key: string): D1PreparedStatement {
  return db.prepare(`SELECT 1 AS ok FROM backup_part WHERE object_key = ?1 LIMIT 1`).bind(key);
}

/**
 * Create the single RUNNING job, capturing every table's max(rowid) in the SAME statement
 * (high-water marks). Inserts nothing when another job is RUNNING (changes = 0); the partial
 * unique index is the race-safe backstop.
 */
export function insertJob(
  db: D1Database,
  id: string,
  startedAt: string,
  startedBy: number | null,
  purgeAfter: string,
): D1PreparedStatement {
  const pairs = BACKUP_TABLES.map((t) => `'${t}', (SELECT coalesce(max(rowid), 0) FROM ${quoteIdent(t)})`).join(', ');
  return db
    .prepare(
      `INSERT INTO backup_job (id, status, started_at, started_by, purge_after, high_water_json)
       SELECT ?1, 'RUNNING', ?2, ?3, ?4, json_object(${pairs})
        WHERE NOT EXISTS (SELECT 1 FROM backup_job WHERE status = 'RUNNING')`,
    )
    .bind(id, startedAt, startedBy, purgeAfter);
}

/**
 * Atomic lease claim. `nowIso` is the (injectable) clock used for retention expiry;
 * `realNowIso`/`leaseUntilIso` always come from the actual clock so a test/cron time
 * override can never steal or extend a lease.
 */
export function claimLease(
  db: D1Database,
  id: string,
  token: string,
  leaseUntilIso: string,
  nowIso: string,
  realNowIso: string,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE backup_job SET lease_token = ?2, lease_until = ?3
        WHERE id = ?1 AND status = 'RUNNING' AND purge_after > ?4
          AND (lease_until IS NULL OR lease_until <= ?5)
       RETURNING id, started_at, tbl_idx, last_rowid, part_seq, row_count, byte_count, high_water_json`,
    )
    .bind(id, token, leaseUntilIso, nowIso, realNowIso);
}

export function releaseLease(db: D1Database, id: string, token: string): D1PreparedStatement {
  return db
    .prepare(`UPDATE backup_job SET lease_token = NULL, lease_until = NULL WHERE id = ?1 AND lease_token = ?2`)
    .bind(id, token);
}

const CURSOR_GUARD = `status = 'RUNNING' AND lease_token = ?c1
  AND tbl_idx = ?c2 AND last_rowid = ?c3 AND part_seq = ?c4`;

function guard(firstParam: number, requireLiveLease = true): string {
  const cursor = CURSOR_GUARD.replace(/\?c(\d)/g, (_m, n: string) => `?${firstParam + Number(n) - 1}`);
  return requireLiveLease ? `${cursor} AND lease_until > strftime('%Y-%m-%dT%H:%M:%fZ','now')` : cursor;
}

export interface NewPart {
  sequence: number;
  table: BackupTable;
  firstRowid: number;
  lastRowid: number;
  objectKey: string;
  rows: number;
  bytes: number;
  sha256: string;
  createdAt: string;
}

/** Part row, inserted only while the caller still holds the lease at the expected cursor. */
export function insertPartGuarded(db: D1Database, jobId: string, part: NewPart, cur: Cursor): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO backup_part (job_id, sequence, table_name, first_rowid, last_rowid, object_key, rows, bytes, sha256, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
        WHERE EXISTS (SELECT 1 FROM backup_job WHERE id = ?1 AND ${guard(11)})`,
    )
    .bind(
      jobId,
      part.sequence,
      part.table,
      part.firstRowid,
      part.lastRowid,
      part.objectKey,
      part.rows,
      part.bytes,
      part.sha256,
      part.createdAt,
      cur.token,
      cur.tblIdx,
      cur.lastRowid,
      cur.partSeq,
    );
}

/**
 * Advance the cursor and clear the lease, CAS on the old cursor. When adding a part this
 * MUST immediately follow insertPartGuarded in the same batch: changes()>0 proves insertion.
 * Lease expiry is checked on that INSERT, not again here, so a clock tick between the two
 * statements cannot commit the part without advancing its cursor. No worker can interleave
 * a lease takeover within the batch. Cursor-only skips still require a live lease.
 */
export function advanceGuarded(
  db: D1Database,
  jobId: string,
  next: { tblIdx: number; lastRowid: number; parts: number; rows: number; bytes: number },
  cur: Cursor,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE backup_job
          SET tbl_idx = ?2, last_rowid = ?3, part_seq = part_seq + ?4, row_count = row_count + ?5,
              byte_count = byte_count + ?6, lease_token = NULL, lease_until = NULL
         WHERE id = ?1 AND ${guard(7, next.parts === 0)}${next.parts ? ' AND changes() > 0' : ''}`,
    )
    .bind(jobId, next.tblIdx, next.lastRowid, next.parts, next.rows, next.bytes, cur.token, cur.tblIdx, cur.lastRowid, cur.partSeq);
}

export function finishDoneGuarded(
  db: D1Database,
  jobId: string,
  finishedAt: string,
  tblIdx: number,
  manifestJson: string,
  cur: Cursor,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE backup_job
          SET status = 'DONE', finished_at = ?2, tbl_idx = ?3, last_rowid = 0, manifest_json = ?4,
              lease_token = NULL, lease_until = NULL
        WHERE id = ?1 AND ${guard(5)}`,
    )
    .bind(jobId, finishedAt, tblIdx, manifestJson, cur.token, cur.tblIdx, cur.lastRowid, cur.partSeq);
}

export function finishFailedGuarded(
  db: D1Database,
  jobId: string,
  finishedAt: string,
  errorCode: string,
  token: string,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE backup_job SET status = 'FAILED', finished_at = ?2, error_code = ?3, lease_token = NULL, lease_until = NULL
        WHERE id = ?1 AND status = 'RUNNING' AND lease_token = ?4`,
    )
    .bind(jobId, finishedAt, errorCode, token);
}

/** Column names of a whitelisted table (D1 supports PRAGMA table_info). */
export function tableColumns(db: D1Database, table: BackupTable): D1PreparedStatement {
  return db.prepare(`PRAGMA table_info(${quoteIdent(table)})`);
}

/**
 * Sample only rowids + JSON byte lengths (including newline), never column values. Computing
 * escaped JSON lengths inside SQLite avoids buffering 200 potentially huge rows in JS.
 * Exported tables contain TEXT/INTEGER, not BLOB; JS serialisation is checked again.
 */
export function sampleRows(
  db: D1Database,
  table: BackupTable,
  columns: string[],
  afterRowid: number,
  maxRowid: number,
): D1PreparedStatement {
  const jsonArgs = columns.map((c) => `'${c.replace(/'/g, "''")}', ${quoteIdent(c)}`).join(', ');
  const size = `length(CAST(json_object(${jsonArgs}) AS BLOB)) + 1`;
  return db
    .prepare(
      `SELECT rowid AS r, (${size}) AS sz FROM ${quoteIdent(table)}
        WHERE rowid > ?1 AND rowid <= ?2 ORDER BY rowid LIMIT ${BACKUP_PART_MAX_ROWS}`,
    )
    .bind(afterRowid, maxRowid);
}

export const ROWID_ALIAS = '__backup_rowid';

export function fetchRows(db: D1Database, table: BackupTable, afterRowid: number, uptoRowid: number): D1PreparedStatement {
  return db
    .prepare(
      `SELECT rowid AS ${ROWID_ALIAS}, * FROM ${quoteIdent(table)}
        WHERE rowid > ?1 AND rowid <= ?2 ORDER BY rowid LIMIT ${BACKUP_PART_MAX_ROWS}`,
    )
    .bind(afterRowid, uptoRowid);
}

/** Schema definitions (tables, indexes, triggers) of the exported tables. */
export function selectSchema(db: D1Database): D1PreparedStatement {
  return db
    .prepare(
      `SELECT type, name, tbl_name, sql FROM sqlite_master
        WHERE sql IS NOT NULL AND tbl_name IN (SELECT value FROM json_each(?1))
        ORDER BY tbl_name, CASE type WHEN 'table' THEN 0 ELSE 1 END, name`,
    )
    .bind(JSON.stringify(BACKUP_TABLES));
}

export function selectAllTableNames(db: D1Database): D1PreparedStatement {
  return db.prepare(
    `SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
      ORDER BY name`,
  );
}

export function selectMigrations(db: D1Database): D1PreparedStatement {
  return db.prepare(`SELECT name, applied_at FROM d1_migrations ORDER BY id`);
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

export function selectRunningJobId(db: D1Database, nowIso: string): D1PreparedStatement {
  return db.prepare(`SELECT id FROM backup_job WHERE status = 'RUNNING' AND purge_after > ?1 LIMIT 1`).bind(nowIso);
}

/** One RUNNING job at most; only an expired and unleased job may be abandoned. */
export function selectExpiredRunning(db: D1Database, nowIso: string, realNowIso: string): D1PreparedStatement {
  return db.prepare(
    `SELECT id, row_count, byte_count, part_seq FROM backup_job
      WHERE status = 'RUNNING' AND purge_after <= ?1 AND (lease_until IS NULL OR lease_until <= ?2) LIMIT 1`,
  ).bind(nowIso, realNowIso);
}

export function failExpiredRunning(db: D1Database, id: string, nowIso: string, realNowIso: string): D1PreparedStatement {
  return db.prepare(
    `UPDATE backup_job SET status = 'FAILED', finished_at = ?2, error_code = 'BACKUP_EXPIRED',
                           lease_token = NULL, lease_until = NULL
      WHERE id = ?1 AND status = 'RUNNING' AND purge_after <= ?2 AND (lease_until IS NULL OR lease_until <= ?3)`,
  ).bind(id, nowIso, realNowIso);
}


export function selectExpiredJobIds(db: D1Database, nowIso: string, limit: number): D1PreparedStatement {
  return db
    .prepare(
      `SELECT id FROM backup_job WHERE purge_after <= ?1 AND status IN ('DONE', 'FAILED')
        ORDER BY purge_after, id LIMIT ?2`,
    )
    .bind(nowIso, limit);
}

/** Durably queue the exact part keys of an expired finished job for R2 deletion (bucket BACKUPS). */
export function enqueueExpiredParts(db: D1Database, id: string, nowIso: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO r2_purge_queue (bucket, object_key, source, enqueued_at)
       SELECT 'BACKUPS', bp.object_key, 'BACKUP_EXPIRED', ?2 FROM backup_part bp
        WHERE bp.job_id = ?1
          AND EXISTS (SELECT 1 FROM backup_job j
                       WHERE j.id = ?1 AND j.purge_after <= ?2 AND j.status IN ('DONE', 'FAILED'))
       ON CONFLICT (bucket, object_key) DO NOTHING`,
    )
    .bind(id, nowIso);
}

/** Same guard as enqueueExpiredParts; parts cascade. */
export function deleteExpiredJob(db: D1Database, id: string, nowIso: string): D1PreparedStatement {
  return db
    .prepare(`DELETE FROM backup_job WHERE id = ?1 AND purge_after <= ?2 AND status IN ('DONE', 'FAILED') RETURNING id`)
    .bind(id, nowIso);
}
