// SQL for the retention purge (Phase 7) and the R2 purge queue (migration 0007).
//
// Every expiry rule lives in ONE predicate builder below. The candidate SELECT, the
// queue INSERT and the guarded DELETE of a category all use the SAME predicate, so the
// queue only ever receives the exact R2 keys of rows the DELETE removes in the same
// db.batch() (one transaction). A concurrent restore / rollback / upload-over-deleted
// that commits first makes the predicate false: nothing is enqueued and nothing deleted.
//
// Placeholders: callers pass the placeholder names (`?1`, `?2`, …) so a predicate can be
// embedded into statements with different bind layouts. `ids` binds a JSON array of
// integer ids (json_each), `now` binds an ISO-8601 UTC timestamp.

/** Retention cutoffs that keep a row alive although its own purge_after passed. */
function versiNotRetained(v: string, now: string): string {
  // A version stays while its document is soft-deleted and still restorable, or while
  // its employee is soft-deleted and still restorable (7 days): restoring either must
  // bring back the full history. Those rows go with the parent's own purge instead.
  return `NOT EXISTS (
      SELECT 1 FROM arsip_dokumen va JOIN pegawai vp ON vp.id = va.pegawai_id
       WHERE va.id = ${v}.arsip_id
         AND ((va.deleted_at IS NOT NULL AND va.purge_after > ${now})
           OR (vp.deleted_at IS NOT NULL AND vp.purge_after > ${now})))`;
}

/** Version expired (purge_after <= now) and not held by a retained parent. */
export function versiExpiredSql(v: string, now: string): string {
  return `${v}.purge_after <= ${now} AND ${versiNotRetained(v, now)}`;
}

/** Soft-deleted document whose 3-day retention passed, employee not retained. */
export function arsipExpiredSql(a: string, now: string): string {
  return `${a}.deleted_at IS NOT NULL AND ${a}.purge_after <= ${now}
      AND NOT EXISTS (SELECT 1 FROM pegawai ap WHERE ap.id = ${a}.pegawai_id
                         AND ap.deleted_at IS NOT NULL AND ap.purge_after > ${now})`;
}

/** Soft-deleted employee whose 7-day retention passed. */
export function pegawaiExpiredSql(p: string, now: string): string {
  return `${p}.deleted_at IS NOT NULL AND ${p}.purge_after <= ${now}`;
}

const inIds = (col: string, ids: string): string => `${col} IN (SELECT value FROM json_each(${ids}))`;

/** Delete guard = candidate id set AND the expiry predicate re-checked at delete time. */
export const versiGuardSql = (v: string, ids: string, now: string): string =>
  `${inIds(`${v}.id`, ids)} AND ${versiExpiredSql(v, now)}`;
export const arsipGuardSql = (a: string, ids: string, now: string): string =>
  `${inIds(`${a}.id`, ids)} AND ${arsipExpiredSql(a, now)}`;
export const pegawaiGuardSql = (p: string, ids: string, now: string): string =>
  `${inIds(`${p}.id`, ids)} AND ${pegawaiExpiredSql(p, now)}`;

// ---------------------------------------------------------------------------
// Candidates (read-only, bounded, oldest first; served by idx_*_purge)
// ---------------------------------------------------------------------------

export function selectVersiCandidates(db: D1Database, nowIso: string, limit: number): D1PreparedStatement {
  return db
    .prepare(
      `SELECT v.id FROM arsip_dokumen_versi v
        WHERE ${versiExpiredSql('v', '?1')}
        ORDER BY v.purge_after, v.id LIMIT ?2`,
    )
    .bind(nowIso, limit);
}

export function selectArsipCandidates(db: D1Database, nowIso: string, limit: number): D1PreparedStatement {
  return db
    .prepare(
      `SELECT a.id FROM arsip_dokumen a
        WHERE ${arsipExpiredSql('a', '?1')}
        ORDER BY a.purge_after, a.id LIMIT ?2`,
    )
    .bind(nowIso, limit);
}

export function selectPegawaiCandidates(db: D1Database, nowIso: string, limit: number): D1PreparedStatement {
  return db
    .prepare(
      `SELECT p.id FROM pegawai p
        WHERE ${pegawaiExpiredSql('p', '?1')}
        ORDER BY p.purge_after, p.id LIMIT ?2`,
    )
    .bind(nowIso, limit);
}

// ---------------------------------------------------------------------------
// Guarded enqueue + delete pairs. Bind layout: ?1 = ids JSON, ?2 = nowIso.
// ON CONFLICT: a key already queued stays queued once, but its lease is cleared. A drain
// that leased the row and saw it still referenced (before this transaction removed the
// reference) then no longer holds the lease, so it cannot drop the row: the next drain
// re-checks and deletes the now-unreferenced object instead of leaking it.
// ---------------------------------------------------------------------------

const ENQUEUE = `INSERT INTO r2_purge_queue (object_key, bucket, source, enqueued_at)`;
const ON_CONFLICT = `ON CONFLICT (bucket, object_key) DO UPDATE SET lease_token = NULL, lease_until = NULL`;

export function enqueueVersiKeys(db: D1Database, idsJson: string, nowIso: string): D1PreparedStatement {
  return db
    .prepare(
      `${ENQUEUE}
       SELECT v.r2_key, 'FILES', 'VERSI_EXPIRED', ?2 FROM arsip_dokumen_versi v
        WHERE ${versiGuardSql('v', '?1', '?2')}
       ${ON_CONFLICT}`,
    )
    .bind(idsJson, nowIso);
}

export function deleteVersi(db: D1Database, idsJson: string, nowIso: string): D1PreparedStatement {
  return db
    .prepare(`DELETE FROM arsip_dokumen_versi AS v WHERE ${versiGuardSql('v', '?1', '?2')} RETURNING id`)
    .bind(idsJson, nowIso);
}

/** Current file of each purged document AND every version row its delete cascades. */
export function enqueueArsipKeys(db: D1Database, idsJson: string, nowIso: string): D1PreparedStatement {
  return db
    .prepare(
      `${ENQUEUE}
       SELECT k, 'FILES', 'ARSIP_EXPIRED', ?2 FROM (
         SELECT a.r2_key AS k FROM arsip_dokumen a WHERE ${arsipGuardSql('a', '?1', '?2')}
         UNION ALL
         SELECT v.r2_key AS k FROM arsip_dokumen_versi v JOIN arsip_dokumen a ON a.id = v.arsip_id
          WHERE ${arsipGuardSql('a', '?1', '?2')}
       ) WHERE 1
       ${ON_CONFLICT}`,
    )
    .bind(idsJson, nowIso);
}

export function deleteArsip(db: D1Database, idsJson: string, nowIso: string): D1PreparedStatement {
  return db
    .prepare(`DELETE FROM arsip_dokumen AS a WHERE ${arsipGuardSql('a', '?1', '?2')} RETURNING id`)
    .bind(idsJson, nowIso);
}

/** Photo + every arsip file + every version file of each purged employee. */
export function enqueuePegawaiKeys(db: D1Database, idsJson: string, nowIso: string): D1PreparedStatement {
  return db
    .prepare(
      `${ENQUEUE}
       SELECT k, 'FILES', 'PEGAWAI_EXPIRED', ?2 FROM (
         SELECT p.foto_r2_key AS k FROM pegawai p
          WHERE ${pegawaiGuardSql('p', '?1', '?2')} AND p.foto_r2_key IS NOT NULL
         UNION ALL
         SELECT a.r2_key AS k FROM arsip_dokumen a JOIN pegawai p ON p.id = a.pegawai_id
          WHERE ${pegawaiGuardSql('p', '?1', '?2')}
         UNION ALL
         SELECT v.r2_key AS k FROM arsip_dokumen_versi v
           JOIN arsip_dokumen a ON a.id = v.arsip_id
           JOIN pegawai p ON p.id = a.pegawai_id
          WHERE ${pegawaiGuardSql('p', '?1', '?2')}
       ) WHERE 1
       ${ON_CONFLICT}`,
    )
    .bind(idsJson, nowIso);
}

/**
 * Document history of purged employees. pegawai ids are not AUTOINCREMENT, so a new
 * employee can receive a purged id; with the same jenis and a reused arsip id it would
 * otherwise match migration 0004's (arsip_id, pegawai_id, jenis) triple and inherit it.
 * Must run BEFORE deletePegawai (same guard, same transaction).
 */
export function deletePegawaiRiwayat(db: D1Database, idsJson: string, nowIso: string): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM arsip_dokumen_riwayat
        WHERE pegawai_id IN (SELECT p.id FROM pegawai p WHERE ${pegawaiGuardSql('p', '?1', '?2')})`,
    )
    .bind(idsJson, nowIso);
}

/**
 * Nullable actor references without FKs must emulate ON DELETE SET NULL, including
 * versions/history owned by OTHER employees. Otherwise rollback copies a stale snapshot
 * actor into an arsip FK (fails), or a reused employee id misattributes historical actions.
 * Re-check the exact employee DELETE guard in every statement, before deleting parents.
 * log_aktivitas is intentionally untouched: its actor names are historical snapshots.
 */
export function clearPegawaiActorReferences(
  db: D1Database,
  idsJson: string,
  nowIso: string,
): D1PreparedStatement[] {
  const purgedIds = `SELECT p.id FROM pegawai p WHERE ${pegawaiGuardSql('p', '?1', '?2')}`;
  return [
    ['arsip_dokumen_versi', 'uploaded_by'],
    ['arsip_dokumen_versi', 'verified_by'],
    ['arsip_dokumen_riwayat', 'actor_id'],
    ['pegawai', 'deleted_by'],
  ].map(([table, column]) =>
    db.prepare(`UPDATE ${table} SET ${column} = NULL WHERE ${column} IN (${purgedIds})`).bind(idsJson, nowIso),
  );
}

/** Cascades akun, sesi, arsip_dokumen (+ versi), pengajuan_perubahan. */
export function deletePegawai(db: D1Database, idsJson: string, nowIso: string): D1PreparedStatement {
  return db
    .prepare(`DELETE FROM pegawai AS p WHERE ${pegawaiGuardSql('p', '?1', '?2')} RETURNING id`)
    .bind(idsJson, nowIso);
}

/**
 * SYSTEM audit row with summary counts only (no ids, names or keys). Placed FIRST in the
 * purge batch: inside the transaction the counts equal what the following guarded
 * DELETEs remove. Inserted only when something matches.
 * Binds: ?1 versi ids, ?2 now, ?3 arsip ids, ?4 pegawai ids.
 */
export function purgeAuditStatement(
  db: D1Database,
  versiIds: string,
  nowIso: string,
  arsipIds: string,
  pegawaiIds: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO log_aktivitas
         (ts, actor_id, actor_nip, actor_nama, actor_role, action, target_type, target_id, description, result, ip)
       SELECT ?2, NULL, NULL, 'SYSTEM', 'SYSTEM', 'RETENTION_PURGE', 'SYSTEM', NULL,
              json_object('versions', c.nv, 'documents', c.nd, 'employees', c.ne), 'SUCCESS', NULL
         FROM (SELECT (SELECT count(*) FROM arsip_dokumen_versi v WHERE ${versiGuardSql('v', '?1', '?2')}) AS nv,
                      (SELECT count(*) FROM arsip_dokumen a WHERE ${arsipGuardSql('a', '?3', '?2')}) AS nd,
                      (SELECT count(*) FROM pegawai p WHERE ${pegawaiGuardSql('p', '?4', '?2')}) AS ne) c
        WHERE c.nv + c.nd + c.ne > 0`,
    )
    .bind(versiIds, nowIso, arsipIds, pegawaiIds);
}

// ---------------------------------------------------------------------------
// Queue drain (bucket 'FILES' only; 'BACKUPS' rows belong to the backup job)
// ---------------------------------------------------------------------------

export interface ClaimedRow {
  object_key: string;
  attempts: number;
}

/**
 * Atomically lease up to `limit` due FILES rows (single UPDATE … RETURNING; SQLite
 * serialises writers, so concurrent drains get disjoint sets). Lease re-checked in the
 * outer WHERE.
 */
export function claimFilesRows(
  db: D1Database,
  token: string,
  leaseUntilIso: string,
  nowIso: string,
  limit: number,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE r2_purge_queue SET lease_token = ?1, lease_until = ?2
        WHERE bucket = 'FILES'
          AND (lease_until IS NULL OR lease_until <= ?3)
          AND object_key IN (
            SELECT object_key FROM r2_purge_queue
             WHERE bucket = 'FILES'
               AND (next_attempt_at IS NULL OR next_attempt_at <= ?3)
               AND (lease_until IS NULL OR lease_until <= ?3)
             ORDER BY enqueued_at, object_key LIMIT ?4)
        RETURNING object_key, attempts`,
    )
    .bind(token, leaseUntilIso, nowIso, limit);
}

/** Keys (from the JSON array ?1) still referenced by any row that can hold a FILES key. */
export function selectReferencedKeys(db: D1Database, keysJson: string): D1PreparedStatement {
  return db
    .prepare(
      `SELECT k.value AS object_key FROM json_each(?1) k
        WHERE EXISTS (SELECT 1 FROM arsip_dokumen WHERE r2_key = k.value)
           OR EXISTS (SELECT 1 FROM arsip_dokumen_versi WHERE r2_key = k.value)
           OR EXISTS (SELECT 1 FROM pegawai WHERE foto_r2_key = k.value)`,
    )
    .bind(keysJson);
}

/** Finish: remove leased rows we still hold (object deleted, or referenced/dropped). */
export function deleteLeasedRows(db: D1Database, token: string, keysJson: string): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM r2_purge_queue
        WHERE bucket = 'FILES' AND lease_token = ?1 AND object_key IN (SELECT value FROM json_each(?2))`,
    )
    .bind(token, keysJson);
}

/**
 * Failure: keep rows queued, release the lease, back off exponentially
 * (60 s · 2^attempts, capped at 6 h) and store a constant safe error code.
 */
export function failLeasedRows(
  db: D1Database,
  token: string,
  keysJson: string,
  nowIso: string,
  errorCode: string,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE r2_purge_queue
          SET attempts = attempts + 1, lease_token = NULL, lease_until = NULL, last_error = ?4,
              next_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', ?3,
                '+' || min(60 * (1 << min(attempts, 9)), 21600) || ' seconds')
        WHERE bucket = 'FILES' AND lease_token = ?1 AND object_key IN (SELECT value FROM json_each(?2))`,
    )
    .bind(token, keysJson, nowIso, errorCode);
}
