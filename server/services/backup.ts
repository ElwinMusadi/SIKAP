// Phase 7 resumable private logical backup (contract: shared/backup.ts, schema 0008).
//
// Model
//   * createBackupJob() inserts the single RUNNING job and, in the same statement, captures
//     max(rowid) of every whitelisted table (high-water marks) so append-only tables
//     (log_aktivitas receives the backup's own audit rows) cannot keep a job alive forever.
//   * stepBackup() does ONE bounded unit of work under a 60 s lease (real clock):
//     claim (atomic UPDATE … RETURNING) → read <= 200 rows of one table by rowid, capped at
//     256 KB of NDJSON → R2 put (unique key) → ONE D1 batch inserting the part row and
//     advancing the cursor, both guarded by lease token + previous cursor (CAS) → lease
//     cleared. A lost lease / duplicate step inserts nothing and its fresh object is deleted
//     if unreferenced. Tables without remaining rows are skipped in the same step.
//   * Not a point-in-time snapshot: every chunk is its own read (consistent:false). Rows
//     updated after their chunk keep the older value, rows deleted later stay exported,
//     rows re-inserted with a rowid above the high-water mark are not exported.
//   * Residual: a crash between the R2 put and the D1 batch leaves an unreferenced object
//     (unique name, never served). An R2 lifecycle rule on `backups/` (> 30 days) removes
//     it; the app never lists the bucket.
//   * R2 put failure ⇒ job FAILED with BACKUP_STORAGE_ERROR (no cursor advance), so a broken
//     bucket can never block new jobs indefinitely; the admin simply starts a new backup.

import {
  BACKUP_TABLES,
  type BackupJob,
  type BackupJobResponse,
  type BackupListResponse,
  type BackupPart,
  type BackupTable,
} from '../../shared/backup';
import {
  BACKUP_PART_MAX_ROWS,
  ROWID_ALIAS,
  advanceGuarded,
  claimLease,
  deleteExpiredJob,
  enqueueExpiredParts,
  failExpiredRunning,
  fetchRows,
  finishDoneGuarded,
  finishFailedGuarded,
  insertJob,
  insertPartGuarded,
  isBackupTable,
  partKeyReferenced,
  releaseLease,
  sampleRows,
  selectAllTableNames,
  selectExpiredJobIds,
  selectExpiredRunning,
  selectJob,
  selectManifest,
  selectMigrations,
  selectPartForDownload,
  selectParts,
  selectRecentJobs,
  selectRecentParts,
  selectRunningJobId,
  selectSchema,
  tableColumns,
  type BackupJobRow,
  type BackupPartRow,
  type ClaimRow,
  type Cursor,
} from '../db/backup';
import type { AuthContext, Bindings } from '../env';
import { auditStatement, type AuditActor } from '../lib/audit';
import { bytesToHex } from '../lib/crypto';
import { ApiError, errors } from '../lib/errors';
import { deleteUnreferencedObject } from '../lib/r2';
import { toIso } from '../lib/time';

export type BackupEnv = Pick<Bindings, 'DB' | 'BACKUPS'>;

export const BACKUP_LIMITS = {
  partMaxRows: BACKUP_PART_MAX_ROWS,
  partMaxBytes: 256 * 1024,
  jobMaxBytes: 50 * 1024 * 1024,
  jobMaxParts: 500,
  leaseMs: 60_000,
  retentionDays: 30,
  /** Empty tables / vanished ranges skipped per step before the step yields. */
  maxScansPerStep: BACKUP_TABLES.length + 4,
} as const;

export const BACKUP_ERROR = {
  rowLimit: 'BACKUP_ROW_LIMIT',
  sizeLimit: 'BACKUP_SIZE_LIMIT',
  storage: 'BACKUP_STORAGE_ERROR',
  metadata: 'BACKUP_METADATA_ERROR',
  expired: 'BACKUP_EXPIRED',
} as const;

export const BACKUP_NOT_CONFIGURED = 'Penyimpanan backup belum dikonfigurasi.';
const MSG_NOT_FOUND = 'Backup tidak ditemukan.';
const MSG_RUNNING = 'Masih ada backup yang sedang berjalan.';
const NDJSON = 'application/x-ndjson; charset=utf-8';
export const BACKUP_DOWNLOAD_CSP = "default-src 'none'; sandbox";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SEQUENCE_RE = /^[1-9]\d{0,8}$/;
const encoder = new TextEncoder();

function notConfigured(): ApiError {
  return new ApiError(503, 'INTERNAL_ERROR', BACKUP_NOT_CONFIGURED);
}

function requireBucket(env: BackupEnv): R2Bucket {
  if (!env.BACKUPS) throw notConfigured();
  return env.BACKUPS;
}

function parseJobId(raw: string | undefined): string {
  const id = (raw ?? '').toLowerCase();
  if (!UUID_RE.test(id)) throw errors.notFound(MSG_NOT_FOUND);
  return id;
}

function actorOf(auth: AuthContext | null): AuditActor | null {
  if (!auth) return null;
  const u = auth.user;
  return { id: u.id, nip: u.nip, nama: u.nama, role: u.role };
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function partUrl(jobId: string, sequence: number): string {
  return `/api/admin/backup/${jobId}/parts/${sequence}`;
}

function toPart(r: BackupPartRow): BackupPart {
  return {
    sequence: r.sequence,
    table: r.table_name as BackupTable,
    rows: r.rows,
    bytes: r.bytes,
    downloadUrl: partUrl(r.job_id, r.sequence),
  };
}

function toJob(r: BackupJobRow, parts: BackupPartRow[]): BackupJob {
  const total = BACKUP_TABLES.length;
  const idx = Math.min(r.tbl_idx, total);
  return {
    id: r.id,
    status: r.status,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    purgeAfter: r.purge_after,
    startedBy: r.started_by == null ? null : { id: r.started_by, nama: r.started_by_nama },
    currentTable: r.status === 'RUNNING' && idx < total ? (BACKUP_TABLES[idx] ?? null) : null,
    tablesCompleted: r.status === 'DONE' ? total : idx,
    totalTables: total,
    rowCount: r.row_count,
    byteCount: r.byte_count,
    errorCode: r.error_code,
    consistent: false,
    includesFileBytes: false,
    parts: parts.map(toPart),
  };
}

async function loadJob(db: D1Database, id: string, nowIso: string): Promise<BackupJob> {
  const [jobRes, partRes] = await db.batch([selectJob(db, id, nowIso), selectParts(db, id)]);
  const row = (jobRes?.results as BackupJobRow[] | undefined)?.[0];
  if (!row) throw errors.notFound(MSG_NOT_FOUND);
  return toJob(row, (partRes?.results as BackupPartRow[] | undefined) ?? []);
}

// ---------------------------------------------------------------------------
// Queries for the API
// ---------------------------------------------------------------------------

export async function listBackups(env: BackupEnv, nowMs: number = Date.now()): Promise<BackupListResponse> {
  const nowIso = toIso(nowMs);
  // One batch = one consistent read of both the jobs and exactly their parts (no N+1).
  const [jobRes, partRes] = await env.DB.batch([selectRecentJobs(env.DB, nowIso), selectRecentParts(env.DB, nowIso)]);
  const byJob = new Map<string, BackupPartRow[]>();
  for (const p of (partRes?.results as BackupPartRow[] | undefined) ?? []) {
    const list = byJob.get(p.job_id);
    if (list) list.push(p);
    else byJob.set(p.job_id, [p]);
  }
  const jobs = ((jobRes?.results as BackupJobRow[] | undefined) ?? []).map((j) => toJob(j, byJob.get(j.id) ?? []));
  return { configured: Boolean(env.BACKUPS), jobs };
}

export async function getBackupJob(env: BackupEnv, rawId: string | undefined, nowMs: number = Date.now()): Promise<BackupJobResponse> {
  return { job: await loadJob(env.DB, parseJobId(rawId), toIso(nowMs)) };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

function isUniqueRunningError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed: backup_job\.status/i.test(msg);
}

/**
 * Start a backup job. `auth` null = system/cron actor. 503 without the BACKUPS binding,
 * 409 when another job is RUNNING. Expired abandoned RUNNING jobs are failed first so they
 * cannot block new backups.
 */
export async function createBackupJob(
  env: BackupEnv,
  auth: AuthContext | null = null,
  meta: { ip?: string | null; nowMs?: number } = {},
): Promise<BackupJobResponse> {
  requireBucket(env);
  const db = env.DB;
  const nowMs = meta.nowMs ?? Date.now();
  const nowIso = toIso(nowMs);
  const id = crypto.randomUUID();
  const purgeAfter = toIso(nowMs + BACKUP_LIMITS.retentionDays * 86_400_000);
  await failAbandonedRunning(db, nowIso);
  let res: D1Result[];
  try {
    res = await db.batch([
      insertJob(db, id, nowIso, auth?.user.id ?? null, purgeAfter),
      auditStatement(
        db,
        {
          ts: nowIso,
          actor: actorOf(auth),
          action: 'BACKUP_CREATE',
          targetType: 'backup_job',
          targetId: id,
          description: `Backup logis dimulai (${auth ? 'manual' : 'terjadwal'}).`,
          result: 'SUCCESS',
          ip: meta.ip ?? null,
        },
        { onlyIfPreviousChanged: true },
      ),
    ]);
  } catch (err) {
    if (isUniqueRunningError(err)) throw errors.conflict(MSG_RUNNING, 'status');
    throw err;
  }
  if (!res[0]?.meta.changes) throw errors.conflict(MSG_RUNNING, 'status');
  return { job: await loadJob(db, id, nowIso) };
}

// ---------------------------------------------------------------------------
// Step
// ---------------------------------------------------------------------------

interface StepContext {
  db: D1Database;
  bucket: R2Bucket;
  id: string;
  claim: ClaimRow;
  cur: Cursor;
  actor: AuditActor | null;
  nowIso: string;
}

function parseHighWater(json: string): Record<BackupTable, number> {
  const parsed: unknown = JSON.parse(json);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('BACKUP_METADATA_ERROR');
  const source = parsed as Record<string, unknown>;
  const out = {} as Record<BackupTable, number>;
  for (const table of BACKUP_TABLES) {
    const value = source[table];
    if (!Object.hasOwn(source, table) || typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new Error('BACKUP_METADATA_ERROR');
    }
    out[table] = value;
  }
  return out;
}

async function failJob(ctx: StepContext, code: string): Promise<void> {
  const { db } = ctx;
  await db.batch([
    finishFailedGuarded(db, ctx.id, ctx.nowIso, code, ctx.cur.token),
    auditStatement(
      db,
      {
        ts: ctx.nowIso,
        actor: ctx.actor,
        action: 'BACKUP_FAILED',
        targetType: 'backup_job',
        targetId: ctx.id,
        description: `Backup logis gagal: ${code} (part ${ctx.cur.partSeq}, baris ${ctx.claim.row_count}).`,
        result: 'FAILURE',
      },
      { onlyIfPreviousChanged: true },
    ),
  ]);
}

interface ManifestTable {
  name: BackupTable;
  highWaterRowid: number;
  rows: number;
  parts: number;
}

async function buildManifest(ctx: StepContext, highWater: Record<string, number>): Promise<string> {
  const { db } = ctx;
  const [partRes, schemaRes, tableRes] = await db.batch([selectParts(db, ctx.id), selectSchema(db), selectAllTableNames(db)]);
  const parts = (partRes?.results as BackupPartRow[] | undefined) ?? [];
  let migrations: { name: string; appliedAt: string | null }[];
  try {
    const m = await selectMigrations(db).all<{ name: string; applied_at: string | null }>();
    migrations = m.results.map((r) => ({ name: r.name, appliedAt: r.applied_at }));
  } catch {
    migrations = []; // migrations table name differs (e.g. custom tooling): identifiers unavailable
  }
  const tables: ManifestTable[] = BACKUP_TABLES.map((name) => ({ name, highWaterRowid: highWater[name] ?? 0, rows: 0, parts: 0 }));
  const byName = new Map(tables.map((t) => [t.name as string, t]));
  for (const p of parts) {
    const t = byName.get(p.table_name);
    if (t) {
      t.rows += p.rows;
      t.parts += 1;
    }
  }
  const allTables = ((tableRes?.results as { name: string }[] | undefined) ?? []).map((r) => r.name);
  const included = new Set<string>(BACKUP_TABLES);
  const manifest = {
    format: 'sikap-logical-backup',
    version: 1,
    jobId: ctx.id,
    startedAt: ctx.claim.started_at,
    finishedAt: ctx.nowIso,
    consistent: false,
    pointInTime: false,
    includesFileBytes: false,
    warning:
      'Ekspor logis bertahap: setiap part dibaca terpisah sehingga BUKAN snapshot satu titik waktu ' +
      '(consistent:false). Untuk pemulihan bencana yang konsisten gunakan D1 Time Travel / wrangler d1 export. ' +
      'Isi file R2 (dokumen/foto) TIDAK disalin; kolom r2_key/sha256 hanya inventaris.',
    secrets: {
      excluded: ['PASSWORD_PEPPER', 'SETTINGS_ENC_KEY'],
      note:
        'akun.password_hash dan nilai pengaturan rahasia (ciphertext AES-GCM) disertakan; keduanya hanya dapat ' +
        'dipakai dengan kunci asli yang disimpan terpisah. Tidak ada endpoint restore/import.',
    },
    format_details: {
      encoding: 'NDJSON UTF-8, satu objek JSON per baris (nama kolom → nilai), diurutkan menurut rowid',
      partMaxRows: BACKUP_LIMITS.partMaxRows,
      partMaxBytes: BACKUP_LIMITS.partMaxBytes,
    },
    totals: { rows: ctx.claim.row_count, bytes: ctx.claim.byte_count, parts: parts.length },
    tables,
    excludedTables: allTables.filter((t) => !included.has(t)),
    parts: parts.map((p) => ({
      sequence: p.sequence,
      table: p.table_name,
      firstRowid: p.first_rowid,
      lastRowid: p.last_rowid,
      rows: p.rows,
      bytes: p.bytes,
      sha256: p.sha256,
    })),
    migrations,
    schema: ((schemaRes?.results as { type: string; name: string; tbl_name: string; sql: string }[] | undefined) ?? []).map(
      (s) => ({ type: s.type, name: s.name, table: s.tbl_name, sql: s.sql }),
    ),
  };
  return JSON.stringify(manifest);
}

async function finishDone(ctx: StepContext, tblIdx: number, highWater: Record<string, number>): Promise<void> {
  const { db } = ctx;
  const manifest = await buildManifest(ctx, highWater);
  await db.batch([
    finishDoneGuarded(db, ctx.id, ctx.nowIso, tblIdx, manifest, ctx.cur),
    auditStatement(
      db,
      {
        ts: ctx.nowIso,
        actor: ctx.actor,
        action: 'BACKUP_DONE',
        targetType: 'backup_job',
        targetId: ctx.id,
        description: `Backup logis selesai: ${ctx.claim.row_count} baris, ${ctx.cur.partSeq} part, ${ctx.claim.byte_count} byte.`,
        result: 'SUCCESS',
      },
      { onlyIfPreviousChanged: true },
    ),
  ]);
}

interface Chunk {
  table: BackupTable;
  tblIdx: number;
  firstRowid: number;
  lastRowid: number;
  maxRowid: number;
  body: Uint8Array;
  rows: number;
}

type ChunkOutcome =
  | { kind: 'chunk'; chunk: Chunk }
  | { kind: 'done'; tblIdx: number }
  | { kind: 'skip'; tblIdx: number; lastRowid: number }
  | { kind: 'fail'; code: string };

/** Find and serialise the next bounded chunk, never buffering more than one part. */
async function nextChunk(ctx: StepContext, highWater: Record<string, number>): Promise<ChunkOutcome> {
  const { db } = ctx;
  let tblIdx = ctx.cur.tblIdx;
  let after = ctx.cur.lastRowid;
  for (let scans = 0; scans < BACKUP_LIMITS.maxScansPerStep; scans += 1) {
    if (tblIdx >= BACKUP_TABLES.length) return { kind: 'done', tblIdx };
    const table = BACKUP_TABLES[tblIdx] as BackupTable;
    const max = highWater[table] ?? 0;
    if (after >= max) {
      tblIdx += 1;
      after = 0;
      continue;
    }
    const cols = (await tableColumns(db, table).all<{ name: string }>()).results.map((c) => c.name);
    const sample = (await sampleRows(db, table, cols, after, max).all<{ r: number; sz: number }>()).results;
    const first = sample[0];
    if (!first) {
      tblIdx += 1;
      after = 0;
      continue;
    }
    // Estimate is a lower bound of the JSON size; a single row above the cap can never fit.
    if (first.sz + 1 > BACKUP_LIMITS.partMaxBytes) return { kind: 'fail', code: BACKUP_ERROR.rowLimit };
    let est = 0;
    let upto = first.r;
    for (const s of sample) {
      if (est + s.sz + 1 > BACKUP_LIMITS.partMaxBytes) break;
      est += s.sz + 1;
      upto = s.r;
    }
    const rows = (await fetchRows(db, table, after, upto).all<Record<string, unknown>>()).results;
    if (!rows.length) {
      // Rows in (after, upto] vanished since sampling: nothing left to export there.
      after = upto;
      continue;
    }
    const lines: string[] = [];
    let bytes = 0;
    let firstRowid = 0;
    let lastRowid = after;
    for (const row of rows) {
      const rowid = Number(row[ROWID_ALIAS]);
      delete row[ROWID_ALIAS];
      const line = `${JSON.stringify(row)}\n`;
      const len = encoder.encode(line).byteLength;
      if (bytes + len > BACKUP_LIMITS.partMaxBytes) {
        if (!lines.length) return { kind: 'fail', code: BACKUP_ERROR.rowLimit };
        break; // advance only to the last row actually included
      }
      lines.push(line);
      bytes += len;
      if (!firstRowid) firstRowid = rowid;
      lastRowid = rowid;
    }
    return {
      kind: 'chunk',
      chunk: { table, tblIdx, firstRowid, lastRowid, maxRowid: max, body: encoder.encode(lines.join('')), rows: lines.length },
    };
  }
  return { kind: 'skip', tblIdx, lastRowid: after };
}

async function runStep(ctx: StepContext): Promise<void> {
  const { db, bucket, id, cur } = ctx;
  let highWater: Record<BackupTable, number>;
  try {
    highWater = parseHighWater(ctx.claim.high_water_json);
  } catch {
    return failJob(ctx, BACKUP_ERROR.metadata);
  }
  const outcome = await nextChunk(ctx, highWater);
  if (outcome.kind === 'fail') return failJob(ctx, outcome.code);
  if (outcome.kind === 'done') return finishDone(ctx, outcome.tblIdx, highWater);
  if (outcome.kind === 'skip') {
    await advanceGuarded(db, id, { tblIdx: outcome.tblIdx, lastRowid: outcome.lastRowid, parts: 0, rows: 0, bytes: 0 }, cur).run();
    return;
  }

  const { chunk } = outcome;
  const bytes = chunk.body.byteLength;
  if (cur.partSeq + 1 > BACKUP_LIMITS.jobMaxParts || ctx.claim.byte_count + bytes > BACKUP_LIMITS.jobMaxBytes) {
    return failJob(ctx, BACKUP_ERROR.sizeLimit);
  }

  const sequence = cur.partSeq + 1;
  const key = `backups/${id}/${String(sequence).padStart(4, '0')}-${crypto.randomUUID()}.ndjson`;
  const sha256 = bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', chunk.body)));
  try {
    await bucket.put(key, chunk.body, { httpMetadata: { contentType: NDJSON }, sha256 });
  } catch (err) {
    console.error('[backup] part upload failed', id, sequence, err instanceof Error ? err.name : 'error');
    await deleteUnreferencedObject(bucket, key, partKeyReferenced(db, key));
    return failJob(ctx, BACKUP_ERROR.storage);
  }

  const tableDone = chunk.lastRowid >= chunk.maxRowid;
  let res: D1Result[];
  try {
    res = await db.batch([
      insertPartGuarded(
        db,
        id,
        {
          sequence,
          table: chunk.table,
          firstRowid: chunk.firstRowid,
          lastRowid: chunk.lastRowid,
          objectKey: key,
          rows: chunk.rows,
          bytes,
          sha256,
          createdAt: ctx.nowIso,
        },
        cur,
      ),
      advanceGuarded(
        db,
        id,
        {
          tblIdx: tableDone ? chunk.tblIdx + 1 : chunk.tblIdx,
          lastRowid: tableDone ? 0 : chunk.lastRowid,
          parts: 1,
          rows: chunk.rows,
          bytes,
        },
        cur,
      ),
    ]);
  } catch (err) {
    await deleteUnreferencedObject(bucket, key, partKeyReferenced(db, key));
    throw err;
  }
  // Lost the lease / cursor moved: nothing was recorded, drop our fresh object.
  if (!res[1]?.meta.changes) await deleteUnreferencedObject(bucket, key, partKeyReferenced(db, key));
}

async function stepInternal(
  env: BackupEnv,
  rawId: string,
  auth: AuthContext | null,
  nowMs: number,
): Promise<{ job: BackupJob; progressed: boolean }> {
  const bucket = requireBucket(env);
  const db = env.DB;
  const id = parseJobId(rawId);
  const nowIso = toIso(nowMs);
  const token = crypto.randomUUID();
  // Lease timing always uses the real clock (an injected nowMs only drives retention).
  const realNow = Date.now();
  const claim = await claimLease(db, id, token, toIso(realNow + BACKUP_LIMITS.leaseMs), nowIso, toIso(realNow)).first<ClaimRow>();
  if (!claim) return { job: await loadJob(db, id, nowIso), progressed: false };
  const ctx: StepContext = {
    db,
    bucket,
    id,
    claim,
    cur: { token, tblIdx: claim.tbl_idx, lastRowid: claim.last_rowid, partSeq: claim.part_seq },
    actor: actorOf(auth),
    nowIso,
  };
  try {
    await runStep(ctx);
  } finally {
    // Every guarded write already clears it; this covers errors and lost-race paths.
    await releaseLease(db, id, token)
      .run()
      .catch(() => undefined);
  }
  return { job: await loadJob(db, id, nowIso), progressed: true };
}

/**
 * One bounded step of a job. Idempotent: a job that is leased by another worker, DONE or
 * FAILED is returned unchanged. 503 without BACKUPS, 404 for unknown/expired jobs.
 */
export async function stepBackup(
  env: BackupEnv,
  rawId: string,
  auth: AuthContext | null = null,
  nowMs: number = Date.now(),
): Promise<BackupJobResponse> {
  return { job: (await stepInternal(env, rawId, auth, nowMs)).job };
}

export interface RunBackupStepsResult {
  configured: boolean;
  jobId: string | null;
  steps: number;
  status: BackupJob['status'] | null;
}

/** Cron helper: advance the (single) active job by at most `maxSteps` (clamped 1..20) steps. */
export async function runBackupSteps(env: BackupEnv, nowMs: number = Date.now(), maxSteps = 1): Promise<RunBackupStepsResult> {
  if (!env.BACKUPS) return { configured: false, jobId: null, steps: 0, status: null };
  const row = await selectRunningJobId(env.DB, toIso(nowMs)).first<{ id: string }>();
  if (!row) return { configured: true, jobId: null, steps: 0, status: null };
  const budget = Math.max(1, Math.min(20, Math.floor(maxSteps)));
  let steps = 0;
  let status: BackupJob['status'] | null = 'RUNNING';
  while (steps < budget) {
    const out = await stepInternal(env, row.id, null, nowMs);
    status = out.job.status;
    if (!out.progressed) break;
    steps += 1;
    if (status !== 'RUNNING') break;
  }
  return { configured: true, jobId: row.id, steps, status };
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

export interface BackupDownload {
  body: ReadableStream | string;
  headers: Record<string, string>;
}

function stamp(iso: string): string {
  return iso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '-');
}

function downloadHeaders(contentType: string, fileName: string, length?: number): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': contentType,
    'Content-Disposition': `attachment; filename="${fileName}"`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': BACKUP_DOWNLOAD_CSP,
  };
  if (length !== undefined) h['Content-Length'] = String(length);
  return h;
}

export async function getPartDownload(
  env: BackupEnv,
  rawId: string | undefined,
  rawSequence: string | undefined,
  nowMs: number = Date.now(),
): Promise<BackupDownload> {
  const bucket = requireBucket(env);
  const id = parseJobId(rawId);
  if (!SEQUENCE_RE.test(rawSequence ?? '')) throw errors.notFound(MSG_NOT_FOUND);
  const sequence = Number(rawSequence);
  const part = await selectPartForDownload(env.DB, id, sequence, toIso(nowMs)).first<{
    table_name: string;
    object_key: string;
    bytes: number;
    started_at: string;
  }>();
  if (!part) throw errors.notFound(MSG_NOT_FOUND);
  const obj = await bucket.get(part.object_key);
  if (!obj) throw errors.notFound(MSG_NOT_FOUND);
  const table = isBackupTable(part.table_name) ? part.table_name : 'data';
  const fileName = `sikap-backup-${stamp(part.started_at)}-${String(sequence).padStart(4, '0')}-${table}.ndjson`;
  return { body: obj.body, headers: downloadHeaders(NDJSON, fileName, obj.size) };
}

export async function getManifestDownload(env: BackupEnv, rawId: string | undefined, nowMs: number = Date.now()): Promise<BackupDownload> {
  const id = parseJobId(rawId);
  const row = await selectManifest(env.DB, id, toIso(nowMs)).first<{ status: string; started_at: string; manifest_json: string | null }>();
  if (!row || row.status !== 'DONE' || !row.manifest_json) throw errors.notFound(MSG_NOT_FOUND);
  const fileName = `sikap-backup-${stamp(row.started_at)}-manifest.json`;
  return {
    body: row.manifest_json,
    headers: downloadHeaders('application/json; charset=utf-8', fileName, encoder.encode(row.manifest_json).byteLength),
  };
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

async function failAbandonedRunning(db: D1Database, nowIso: string): Promise<number> {
  const realNowIso = toIso(Date.now());
  const row = await selectExpiredRunning(db, nowIso, realNowIso).first<{
    id: string; row_count: number; byte_count: number; part_seq: number;
  }>();
  if (!row) return 0;
  const [res] = await db.batch([
    failExpiredRunning(db, row.id, nowIso, realNowIso),
    auditStatement(db, {
      ts: nowIso, actor: null, action: 'BACKUP_FAILED', targetType: 'backup_job', targetId: row.id,
      description: `Backup logis gagal: BACKUP_EXPIRED (${row.row_count} baris, ${row.part_seq} part, ${row.byte_count} byte).`,
      result: 'FAILURE',
    }, { onlyIfPreviousChanged: true }),
  ]);
  return res?.meta.changes ?? 0;
}

export interface PurgeBackupResult {
  failedExpiredRunning: number;
  jobsDeleted: number;
  keysQueued: number;
}

/**
 * Bounded retention sweep (cron): fail abandoned expired RUNNING jobs, then for up to `limit`
 * expired DONE/FAILED jobs durably enqueue their exact part keys in r2_purge_queue (bucket
 * 'BACKUPS') and delete the job (parts cascade) in ONE batch with the same guard. Does not
 * touch R2 itself; the queue drain owns object deletion. Returns counts only, never keys.
 */
export async function purgeBackupJobs(env: Pick<Bindings, 'DB'>, nowMs: number = Date.now(), limit = 1): Promise<PurgeBackupResult> {
  const db = env.DB;
  const nowIso = toIso(nowMs);
  const failed = await failAbandonedRunning(db, nowIso);
  const max = Math.max(1, Math.min(50, Math.floor(limit)));
  const ids = (await selectExpiredJobIds(db, nowIso, max).all<{ id: string }>()).results;
  let jobsDeleted = 0;
  let keysQueued = 0;
  for (const { id } of ids) {
    const [enq, del] = await db.batch([enqueueExpiredParts(db, id, nowIso), deleteExpiredJob(db, id, nowIso)]);
    keysQueued += enq?.meta.changes ?? 0;
    jobsDeleted += del?.results.length ?? 0; // meta.changes also counts cascaded part deletions
  }
  return { failedExpiredRunning: failed, jobsDeleted, keysQueued };
}
