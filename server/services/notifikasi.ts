// Phase 5: WhatsApp notification outbox (contract: shared/verifikasi.ts).
//
// WRITE SIDE — outboxStatements():
//   Rows are inserted in the SAME db.batch() as the triggering mutation, so a
//   notification is never lost and never exists without its mutation.
//   Settings and recipients are read BEFORE the batch (in the caller's existing
//   pre-read round trip); the batch then only contains plain INSERTs.
//
//   GUARD: a batch is one transaction, but a compare-and-set that matches no row is
//   NOT an error: the batch commits and the request answers 409. SQLite `changes()`
//   only sees the immediately previous statement, so it cannot guard several outbox
//   rows. Every outbox INSERT is therefore guarded by the mutation's POST-CONDITION:
//     INSERT … SELECT … WHERE EXISTS (SELECT 1 FROM arsip_dokumen WHERE <state the
//     mutation must have produced>)
//   e.g. decision: id + versi + new status + verified_by = admin + verified_at = now;
//   upload: (pegawai, jenis) slot holds the new (random, unique) r2_key + status 'Menunggu'. If the CAS failed,
//   the post-condition is false and no row is inserted.
//   INSERTs use RETURNING id so the caller can flush exactly those rows.
//
// SEND SIDE — flushOutbox():
//   Called via waitUntil() after the response (deferBackground(), ≤ 30 s budget) and by
//   the cron. Several flushes may overlap, so rows are CLAIMED before sending
//   (migration 0005):
//     1. One batch: read WA settings + atomically lease ≤ FLUSH_LIMIT due rows
//        (UPDATE … WHERE id IN (SELECT due, unleased-or-expired … LIMIT n) RETURNING).
//        The lease token is a fresh crypto.randomUUID() per flush; lease = 60 s, well
//        above the 24 s send budget, so a live flush never loses its lease.
//     2. No usable provider config (missing / undecryptable): no fetch, NO attempt is
//        consumed; rows get next_attempt_at = now + 10 min and a generic last_error.
//     3. Otherwise ≤ MAX_PARALLEL sends at a time (each ≤ SEND_TIMEOUT_MS = 8 s; 6 rows
//        = two waves ≈ 16 s). Each row's outcome is written IMMEDIATELY, conditioned on
//        (id, lease_token), and clears the lease. No new send starts unless it can finish
//        within the 24 s budget; rows never started are released untouched.
//   Failure: attempts+1, generic last_error, next_attempt_at = now + backoff; the 5th
//   failure → FAILED. Subrequests per call ≤ 1 batch + 6 fetches + 6 updates + 1 release.
//
//   DELIVERY SEMANTICS: AT-LEAST-ONCE. If the provider accepted a message but the worker
//   died (or D1 failed) before the SENT update, the lease expires and the row is sent
//   again. Exactly-once is impossible without provider-side idempotency keys.
//
//   No module-level state is used on the send path (Workers isolates are shared by
//   unrelated requests); deferredForTests below is a test-only shim used when there is
//   no ExecutionContext.
import type { Context } from 'hono';
import type { WaTemplate } from '../../shared/verifikasi';
import type { AppEnv } from '../env';
import { selectSettings, WA_KEYS, SETTING_KEYS, type SettingRow } from '../db/pengaturan';
import { toIso } from '../lib/time';
import { SEND_TIMEOUT_MS, sanitizeDetail, sendWhatsApp, type WaConfig } from '../lib/whatsapp';
import { WA_NOT_CONFIGURED, waConfigFromRows, type WaEnv } from './pengaturan';

export const MAX_ATTEMPTS = 5;
/** Rows claimed per flush (two waves of MAX_PARALLEL). */
export const FLUSH_LIMIT = 6;
/** Simultaneous provider requests per flush. */
export const MAX_PARALLEL = 3;
/** Lease length; must exceed SEND_BUDGET_MS plus D1 latency. */
export const LEASE_MS = 60_000;
/** Wall-clock ceiling for sending inside one flush (waitUntil allows 30 s). */
export const SEND_BUDGET_MS = 24_000;
/** Retry delay when the provider is not configured (no attempt consumed). */
export const UNCONFIGURED_DELAY_MS = 10 * 60_000;
/** Delay before retry n+1 after the n-th failed attempt (index = attempts after failure). */
const BACKOFF_MS = [0, 2 * 60_000, 10 * 60_000, 30 * 60_000, 60 * 60_000];
/** Margin for the row's own D1 write after the send. */
const WRITE_MARGIN_MS = 1_000;
const MAX_LAST_ERROR = 300;

/** Bindings needed to flush (narrow, so the cron worker can call it). */
export type OutboxEnv = WaEnv;

export interface OutboxMessage {
  target: string;
  template: WaTemplate;
  params: Record<string, string>;
}

/** SQL post-condition on `arsip_dokumen` (no alias) + its bind values. */
export interface OutboxGuard {
  where: string;
  binds: unknown[];
  /**
   * Also require that the statement immediately BEFORE the (single) outbox INSERT
   * changed a row (`changes() > 0`). Use when the post-condition alone can be satisfied
   * by an earlier, identical request (same actor + same millisecond). Only valid for one
   * message per guard: a second INSERT would see the first INSERT's changes().
   */
  requirePreviousChange?: boolean;
}

/** Guard for an admin decision (approve/reject). */
export function decisionGuard(
  arsipId: number,
  versi: number,
  status: 'Terverifikasi' | 'Ditolak',
  adminId: number,
  nowIso: string,
): OutboxGuard {
  // Two identical decisions by the same admin in the same millisecond produce the same
  // post-condition; the loser's CAS changes nothing, so its gated audit inserts nothing,
  // and requirePreviousChange stops its outbox INSERT (caller places it right after the
  // audit statement).
  return {
    where: 'id = ? AND versi = ? AND status = ? AND verified_by = ? AND verified_at = ? AND deleted_at IS NULL',
    binds: [arsipId, versi, status, adminId, nowIso],
    requirePreviousChange: true,
  };
}

/** Guard for an upload: the arsip now points at the freshly stored (unique) R2 key. */
export function uploadGuard(pegawaiId: number, jenisId: string, r2Key: string): OutboxGuard {
  // (pegawai_id, jenis_dokumen_id) hits the UNIQUE index; r2_key is the post-condition.
  return {
    where: `pegawai_id = ? AND jenis_dokumen_id = ? AND r2_key = ? AND status = 'Menunggu' AND deleted_at IS NULL`,
    binds: [pegawaiId, jenisId, r2Key],
  };
}

export function outboxStatements(
  db: D1Database,
  messages: OutboxMessage[],
  guard: OutboxGuard,
  nowIso: string,
): D1PreparedStatement[] {
  if (guard.requirePreviousChange && messages.length > 1) {
    throw new Error('outboxStatements: requirePreviousChange supports a single message');
  }
  // changes() is evaluated first, before the EXISTS subquery.
  const prev = guard.requirePreviousChange ? 'changes() > 0 AND ' : '';
  return messages.map((m) =>
    db
      .prepare(
        `INSERT INTO notifikasi_outbox (channel, target, template, params, status, attempts, created_at)
         SELECT 'whatsapp', ?, ?, ?, 'PENDING', 0, ?
          WHERE ${prev}EXISTS (SELECT 1 FROM arsip_dokumen WHERE ${guard.where})
         RETURNING id`,
      )
      .bind(m.target, m.template, JSON.stringify(m.params), nowIso, ...guard.binds),
  );
}

/** Ids returned by the outbox INSERT … RETURNING statements of a batch. */
export function insertedIds(results: D1Result[]): number[] {
  const ids: number[] = [];
  for (const r of results) {
    for (const row of (r?.results ?? []) as { id?: unknown }[]) {
      if (typeof row.id === 'number') ids.push(row.id);
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Recipients (pre-read statements, to be placed in the caller's first batch)
// ---------------------------------------------------------------------------

/**
 * Active admins with a phone, excluding `excludeId`, ONLY when notif.dokumen_baru is
 * enabled (missing setting = enabled). One statement so it fits an existing batch.
 */
export function selectAdminRecipients(db: D1Database, excludeId: number): D1PreparedStatement {
  return db
    .prepare(
      `SELECT p.id, p.no_hp FROM pegawai p
        WHERE p.role = 'Admin' AND p.status_akun = 'Aktif' AND p.deleted_at IS NULL
          AND p.no_hp IS NOT NULL AND p.no_hp <> '' AND p.id <> ?1
          AND COALESCE((SELECT value FROM pengaturan WHERE key = ?2), 'true') <> 'false'
        ORDER BY p.id`,
    )
    .bind(excludeId, SETTING_KEYS.notifDokumenBaru);
}

// ---------------------------------------------------------------------------
// Background execution
// ---------------------------------------------------------------------------

const deferredForTests: (() => Promise<unknown>)[] = [];

/**
 * Run `task` after the response via waitUntil(). Without an ExecutionContext (unit
 * tests calling app.request()) the task is queued instead and only runs when a test
 * calls runDeferredTasks(), so background work never leaks across tests.
 */
export function deferBackground(c: Context<AppEnv>, task: () => Promise<unknown>): void {
  let ctx: ExecutionContext | undefined;
  try {
    ctx = c.executionCtx as ExecutionContext;
  } catch {
    ctx = undefined;
  }
  if (ctx) {
    ctx.waitUntil(task().catch(() => undefined));
    return;
  }
  deferredForTests.push(task);
  if (deferredForTests.length > 100) deferredForTests.shift();
}

/** Test hook: run (and clear) every task queued by deferBackground(). */
export async function runDeferredTasks(): Promise<void> {
  const tasks = deferredForTests.splice(0);
  for (const t of tasks) await t();
}

/** Test hook: drop queued tasks without running them. */
export function clearDeferredTasks(): void {
  deferredForTests.splice(0);
}

// ---------------------------------------------------------------------------
// Flush
// ---------------------------------------------------------------------------

interface OutboxRow {
  id: number;
  target: string;
  template: WaTemplate;
  params: string;
  attempts: number;
}

export interface FlushResult {
  sent: number;
  failed: number;
  /**
   * Claimed but no outcome persisted by this flush: provider not configured, released at
   * the time budget, or the outcome write lost its lease / failed (row retried later).
   */
  skipped: number;
}

/** Optional knobs (tests / callers with a smaller budget). Not needed in production. */
export interface FlushOptions {
  /** Send budget in ms (default SEND_BUDGET_MS, capped at it). */
  budgetMs?: number;
  /** Monotonic-enough clock for the budget (default Date.now). */
  clock?: () => number;
}

/** Retry time after the n-th failed attempt. */
export function backoffMs(attemptsAfterFailure: number): number {
  return BACKOFF_MS[Math.min(Math.max(attemptsAfterFailure, 1), BACKOFF_MS.length - 1)]!;
}

/**
 * Atomically lease up to `n` due PENDING rows (all, or only `ids`) for `token`.
 * Due = attempts < MAX, next_attempt_at unset or ≤ now, no live lease. The predicates
 * are repeated on the outer UPDATE so the claim is a single compare-and-set.
 */
function claimStatement(db: D1Database, ids: number[] | null, token: string, nowIso: string, leaseIso: string, n: number) {
  const due = `status = 'PENDING' AND attempts < ?3
               AND (next_attempt_at IS NULL OR next_attempt_at <= ?4)
               AND (lease_until IS NULL OR lease_until <= ?4)`;
  const only = ids ? 'AND id IN (SELECT value FROM json_each(?6))' : '';
  const stmt = db.prepare(
    `UPDATE notifikasi_outbox SET lease_token = ?1, lease_until = ?2
      WHERE id IN (SELECT id FROM notifikasi_outbox WHERE ${due} ${only} ORDER BY created_at, id LIMIT ?5)
        AND ${due}
      RETURNING id, target, template, params, attempts`,
  );
  return ids
    ? stmt.bind(token, leaseIso, MAX_ATTEMPTS, nowIso, n, JSON.stringify(ids))
    : stmt.bind(token, leaseIso, MAX_ATTEMPTS, nowIso, n);
}

function parseParams(raw: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function lastError(detail: string | undefined): string {
  return sanitizeDetail(detail ?? 'Gagal mengirim.').slice(0, MAX_LAST_ERROR);
}

/**
 * Send due PENDING rows: the given ids, or (`'pending'`) the oldest due rows (cron).
 * Never throws for provider errors. At-least-once (see header). `nowMs` stamps the
 * lease/retry/sent times; the send budget is measured on `opts.clock`.
 */
export async function flushOutbox(
  env: OutboxEnv,
  which: number[] | 'pending',
  limit: number = FLUSH_LIMIT,
  nowMs: number = Date.now(),
  opts: FlushOptions = {},
): Promise<FlushResult> {
  const result: FlushResult = { sent: 0, failed: 0, skipped: 0 };
  if (Array.isArray(which) && which.length === 0) return result;
  const db = env.DB;
  const clock = opts.clock ?? Date.now;
  const started = clock();
  const budget = Math.min(opts.budgetMs ?? SEND_BUDGET_MS, SEND_BUDGET_MS);
  const n = Math.max(1, Math.min(Math.trunc(limit) || 1, FLUSH_LIMIT));
  const token = crypto.randomUUID();
  const nowIso = toIso(nowMs);

  // Round trip 1: settings + claim.
  const [sRes, cRes] = await db.batch([
    selectSettings(db, WA_KEYS),
    // Lease measured from the LATER of nowMs and the wall clock: a delayed cron passes a
    // stale scheduledTime, which must not yield a lease that expires mid-send.
    claimStatement(db, Array.isArray(which) ? which : null, token, nowIso, toIso(Math.max(nowMs, Date.now()) + LEASE_MS), n),
  ]);
  const rows = ((cRes?.results ?? []) as OutboxRow[]).sort((a, b) => a.id - b.id);
  if (rows.length === 0) return result;

  const cfg = await waConfigFromRows(env, sRes?.results as SettingRow[] | undefined);
  if (!cfg) {
    // Not an attempt: nothing was sent. Re-check in 10 minutes.
    await db
      .prepare(
        `UPDATE notifikasi_outbox
            SET lease_token = NULL, lease_until = NULL, next_attempt_at = ?3, last_error = ?4
          WHERE id IN (SELECT value FROM json_each(?1)) AND lease_token = ?2 AND status = 'PENDING'`,
      )
      .bind(JSON.stringify(rows.map((r) => r.id)), token, toIso(nowMs + UNCONFIGURED_DELAY_MS), WA_NOT_CONFIGURED)
      .run();
    result.skipped = rows.length;
    return result;
  }

  // Bounded pool: MAX_PARALLEL runners pull from a per-call queue (no shared state).
  const queue = rows.slice();
  const unstarted: number[] = [];
  const runner = async () => {
    for (;;) {
      const row = queue.shift();
      if (!row) return;
      if (clock() - started + SEND_TIMEOUT_MS + WRITE_MARGIN_MS > budget) {
        // Could not finish in time: give the row back untouched.
        unstarted.push(row.id, ...queue.splice(0).map((r) => r.id));
        return;
      }
      await sendAndFinish(db, cfg, row, token, nowMs + (clock() - started), result);
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, rows.length) }, runner));

  if (unstarted.length) {
    result.skipped += unstarted.length;
    try {
      await db
        .prepare(
          `UPDATE notifikasi_outbox SET lease_token = NULL, lease_until = NULL
            WHERE id IN (SELECT value FROM json_each(?1)) AND lease_token = ?2 AND status = 'PENDING'`,
        )
        .bind(JSON.stringify(unstarted), token)
        .run();
    } catch {
      // The lease simply expires.
    }
  }
  return result;
}

/** Send one leased row and persist its outcome immediately (only while we hold the lease). */
async function sendAndFinish(
  db: D1Database,
  cfg: WaConfig,
  row: OutboxRow,
  token: string,
  rowNowMs: number,
  result: FlushResult,
): Promise<void> {
  const res = await sendWhatsApp(cfg, row.target, row.template, parseParams(row.params));
  const doneIso = toIso(rowNowMs);
  const stmt = res.ok
    ? db
        .prepare(
          `UPDATE notifikasi_outbox
              SET status = 'SENT', sent_at = ?3, attempts = attempts + 1, last_error = NULL,
                  next_attempt_at = NULL, lease_token = NULL, lease_until = NULL
            WHERE id = ?1 AND lease_token = ?2 AND status = 'PENDING'`,
        )
        .bind(row.id, token, doneIso)
    : db
        .prepare(
          `UPDATE notifikasi_outbox
              SET attempts = attempts + 1, last_error = ?3,
                  status = CASE WHEN attempts + 1 >= ?4 THEN 'FAILED' ELSE 'PENDING' END,
                  next_attempt_at = CASE WHEN attempts + 1 >= ?4 THEN NULL ELSE ?5 END,
                  lease_token = NULL, lease_until = NULL
            WHERE id = ?1 AND lease_token = ?2 AND status = 'PENDING'`,
        )
        .bind(row.id, token, lastError(res.detail), MAX_ATTEMPTS, toIso(rowNowMs + backoffMs(row.attempts + 1)));
  // Count only outcomes that were actually persisted. A lost lease (another flush took
  // over) or a D1 error leaves the row to its current holder / lease expiry → skipped.
  let persisted = false;
  try {
    persisted = ((await stmt.run()).meta.changes ?? 0) === 1;
  } catch {
    // D1 unavailable: the lease expires and the row is retried (at-least-once).
  }
  if (!persisted) result.skipped += 1;
  else if (res.ok) result.sent += 1;
  else result.failed += 1;
}
