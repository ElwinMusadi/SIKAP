// Retention purge (Phase 7, owner decisions #4 and #5) and the R2 delete-queue drain.
//
// purgeExpired(): D1 only. Candidate ids are read OUTSIDE the transaction (bounded), then
// ONE db.batch() (one D1 transaction) runs, per category, "enqueue exact R2 keys" followed
// by "guarded DELETE", both with the identical id-set + expiry predicate
// (server/db/purge.ts). A restore / rollback / upload-over-deleted that commits before the
// batch makes the predicate false, so the row is neither enqueued nor deleted; one that
// would commit after it finds the row gone (or expired, which those paths already reject:
// restore requires purge_after > now, rollback reads only versions with purge_after > now).
//
// drainPurgeQueue(): R2 only for bucket 'FILES'. Why deleting an unreferenced key is safe:
// R2 keys are random UUIDs that are never reused, and every path that can put an EXISTING
// key back into a row (restore, rollback) copies it from an arsip / versi row. Once the
// guarded SQL has removed the last such row, no request can create a new reference to the
// key: uploads and photos always mint fresh keys, and the expiry checks above already block
// restore/rollback of the removed rows. So "unreferenced now" implies "unreferenced
// forever", and the reference check right before the delete closes the remaining gap
// (e.g. a rollback that moved a version's key back into arsip_dokumen before the version
// row was purged). We never delete by prefix: numeric ids are reused, keys are not.
import type { Bindings } from '../env';
import {
  claimFilesRows,
  clearPegawaiActorReferences,
  deleteArsip,
  deleteLeasedRows,
  deletePegawai,
  deletePegawaiRiwayat,
  deleteVersi,
  enqueueArsipKeys,
  enqueuePegawaiKeys,
  enqueueVersiKeys,
  failLeasedRows,
  purgeAuditStatement,
  selectArsipCandidates,
  selectPegawaiCandidates,
  selectReferencedKeys,
  selectVersiCandidates,
  type ClaimedRow,
} from '../db/purge';

export const PURGE_LIMITS = { versions: 100, documents: 25, employees: 5 } as const;
export const DRAIN_LIMIT = 50;
export const DRAIN_LEASE_MS = 5 * 60_000;
/** Constant, PII-free error code stored in r2_purge_queue.last_error. */
export const R2_DELETE_FAILED = 'R2_DELETE_FAILED';

export interface PurgeLimits {
  versions?: number;
  documents?: number;
  employees?: number;
}

export interface PurgeResult {
  /** Rows actually removed by the guarded DELETEs (cascaded rows not counted). */
  versions: number;
  documents: number;
  employees: number;
  /** Enqueue operations (INSERTs and conflict UPDATEs), not unique or newly added keys. */
  queueWrites: number;
}

function clampLimit(value: number | undefined, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return max;
  return Math.min(max, Math.max(0, Math.floor(value)));
}

const ids = (rows: { id: number }[]): string => JSON.stringify(rows.map((r) => r.id));

export async function purgeExpired(db: D1Database, nowMs: number, limits: PurgeLimits = {}): Promise<PurgeResult> {
  const nowIso = new Date(nowMs).toISOString();
  const nVersi = clampLimit(limits.versions, PURGE_LIMITS.versions);
  const nArsip = clampLimit(limits.documents, PURGE_LIMITS.documents);
  const nPegawai = clampLimit(limits.employees, PURGE_LIMITS.employees);

  // Candidates: one read batch (one subrequest), outside the write transaction.
  const [v, a, p] = await db.batch<{ id: number }>([
    selectVersiCandidates(db, nowIso, nVersi),
    selectArsipCandidates(db, nowIso, nArsip),
    selectPegawaiCandidates(db, nowIso, nPegawai),
  ]);
  const versiIds = ids(v?.results ?? []);
  const arsipIds = ids(a?.results ?? []);
  const pegawaiIds = ids(p?.results ?? []);
  if (versiIds === '[]' && arsipIds === '[]' && pegawaiIds === '[]') {
    return { versions: 0, documents: 0, employees: 0, queueWrites: 0 };
  }

  // One transaction. Order matters: versions, then documents (cascade their remaining
  // versions), then employees (owned riwayat deleted and non-FK actor references nulled
  // before the parent disappears, since every cleanup guard reads pegawai). Each enqueue
  // and DELETE uses the same guard; actor cleanup cannot change the expiry predicate.
  const res = await db.batch([
    purgeAuditStatement(db, versiIds, nowIso, arsipIds, pegawaiIds),
    enqueueVersiKeys(db, versiIds, nowIso),
    deleteVersi(db, versiIds, nowIso),
    enqueueArsipKeys(db, arsipIds, nowIso),
    deleteArsip(db, arsipIds, nowIso),
    enqueuePegawaiKeys(db, pegawaiIds, nowIso),
    deletePegawaiRiwayat(db, pegawaiIds, nowIso),
    ...clearPegawaiActorReferences(db, pegawaiIds, nowIso),
    deletePegawai(db, pegawaiIds, nowIso),
  ]);
  const changes = (i: number): number => res[i]?.meta.changes ?? 0;
  return {
    // D1 meta.changes includes FK cascades/SET NULL updates. RETURNING counts only the
    // source rows, keeping the result consistent with the in-transaction audit summary.
    versions: res[2]?.results.length ?? 0,
    documents: res[4]?.results.length ?? 0,
    employees: res[res.length - 1]?.results.length ?? 0,
    // Queue has no cascades/triggers: affected rows are enqueue INSERT/UPDATE operations.
    // Re-enqueuing an existing key clears its lease and counts as another queue write.
    queueWrites: changes(1) + changes(3) + changes(5),
  };
}

// ---------------------------------------------------------------------------
// Drain
// ---------------------------------------------------------------------------

export type PurgeDrainEnv = Pick<Bindings, 'DB' | 'FILES' | 'BACKUPS'>;

export interface DrainResult {
  claimed: number;
  /** Objects removed from R2 (queue rows removed too). */
  deleted: number;
  /** Still referenced: queue row dropped, object kept (re-enqueued when that row is purged). */
  referenced: number;
  /** R2 delete failed: rows kept with backoff. */
  failed: number;
  /** Binding missing; nothing claimed. */
  skipped: boolean;
}

/**
 * Bounded: claim (1) + reference check (1) + one R2 bulk delete (1) + finish (1)
 * subrequests per call, at most DRAIN_LIMIT keys. BACKUPS rows are never claimed here.
 */
export async function drainPurgeQueue(
  env: PurgeDrainEnv,
  nowMs: number,
  limit: number = DRAIN_LIMIT,
): Promise<DrainResult> {
  const result: DrainResult = { claimed: 0, deleted: 0, referenced: 0, failed: 0, skipped: false };
  if (!env.FILES) return { ...result, skipped: true };
  const n = Math.min(DRAIN_LIMIT, Math.max(1, Math.floor(Number.isFinite(limit) ? limit : DRAIN_LIMIT)));
  const nowIso = new Date(nowMs).toISOString();
  // Lease relative to the real clock too, so an injected past nowMs cannot hand out a
  // lease that is already expired for a concurrent drain.
  const leaseUntil = new Date(Math.max(nowMs, Date.now()) + DRAIN_LEASE_MS).toISOString();
  const token = crypto.randomUUID();

  const claimed = (await claimFilesRows(env.DB, token, leaseUntil, nowIso, n).all<ClaimedRow>()).results ?? [];
  result.claimed = claimed.length;
  if (claimed.length === 0) return result;

  const keys = claimed.map((r) => r.object_key);
  const refRows =
    (await selectReferencedKeys(env.DB, JSON.stringify(keys)).all<{ object_key: string }>()).results ?? [];
  const referenced = new Set(refRows.map((r) => r.object_key));
  const unreferenced = keys.filter((k) => !referenced.has(k));
  result.referenced = referenced.size;

  let deleteOk = true;
  if (unreferenced.length > 0) {
    try {
      await env.FILES.delete(unreferenced);
    } catch {
      deleteOk = false;
    }
  }

  if (deleteOk) {
    // Only now remove the queue rows (deleted + referenced), and only those we still lease.
    await deleteLeasedRows(env.DB, token, JSON.stringify(keys)).run();
    result.deleted = unreferenced.length;
    return result;
  }

  // R2 failed: referenced rows are still safe to drop; unreferenced rows stay queued.
  await env.DB.batch([
    deleteLeasedRows(env.DB, token, JSON.stringify([...referenced])),
    failLeasedRows(env.DB, token, JSON.stringify(unreferenced), nowIso, R2_DELETE_FAILED),
  ]);
  result.failed = unreferenced.length;
  return result;
}
