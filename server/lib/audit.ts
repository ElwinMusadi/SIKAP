// Audit log helper (MIGRATION_PLAN §3.1 rule 10): every mutation writes
// `log_aktivitas` in the SAME `db.batch()` as the mutation itself, so this
// returns a prepared statement instead of executing it.

import type { LogResult } from '../../shared/enums';

export interface AuditActor {
  id: number | null;
  nip: string | null;
  nama?: string | null;
  role?: string | null;
}

export interface AuditEntry {
  /** ISO UTC timestamp; defaults to now. */
  ts?: string;
  actor: AuditActor | null;
  action: string;
  targetType?: string | null;
  targetId?: string | number | null;
  description?: string | null;
  result: LogResult;
  ip?: string | null;
}

export interface AuditOptions {
  /**
   * Insert only if the PREVIOUS statement in the same batch changed at least one
   * row (SQLite `changes()`; D1 runs a batch sequentially on one connection).
   */
  onlyIfPreviousChanged?: boolean;
  /**
   * Use the rowid inserted by the PREVIOUS statement in the same batch as target_id
   * (SQLite `last_insert_rowid()`), for targets whose id is unknown before the batch.
   * The statement must directly follow that INSERT. `entry.targetId` is ignored.
   */
  targetIdFromLastInsert?: boolean;
}

const MAX_DESCRIPTION = 500;

export function auditStatement(db: D1Database, entry: AuditEntry, opts: AuditOptions = {}): D1PreparedStatement {
  const a = entry.actor;
  const targetExpr = opts.targetIdFromLastInsert ? 'CAST(last_insert_rowid() AS TEXT)' : '?8';
  const values = `?1, ?2, ?3, ?4, ?5, ?6, ?7, ${targetExpr}, ?9, ?10, ?11`;
  const source = opts.onlyIfPreviousChanged ? `SELECT ${values} WHERE changes() > 0` : `VALUES (${values})`;
  return db
    .prepare(
      `INSERT INTO log_aktivitas
         (ts, actor_id, actor_nip, actor_nama, actor_role, action, target_type, target_id, description, result, ip)
       ${source}`,
    )
    .bind(
      entry.ts ?? new Date().toISOString(),
      a?.id ?? null,
      a?.nip ?? null,
      a?.nama ?? null,
      a?.role ?? null,
      entry.action,
      entry.targetType ?? null,
      entry.targetId == null || opts.targetIdFromLastInsert ? null : String(entry.targetId),
      entry.description == null ? null : entry.description.slice(0, MAX_DESCRIPTION),
      entry.result,
      entry.ip ?? null,
    );
}

/** NIP as typed by an anonymous user: keep only well-formed NIPs, never raw input (could be a password). */
export function maskSubmittedNip(input: string): string {
  return /^\d{18}$/.test(input) ? input : `<invalid:${input.length}>`;
}
