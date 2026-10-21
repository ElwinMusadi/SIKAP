// SQL for the `sesi` table. Only SHA-256(token) is ever stored.

import type { Role, StatusKepegawaian } from '../../shared/enums';

export interface SessionUserRow {
  token_hash: string;
  expires_at: string;
  last_seen_at: string;
  id: number;
  nip: string;
  nama: string;
  role: Role;
  status_kepegawaian: StatusKepegawaian | null;
  jabatan: string | null;
  foto_r2_key: string | null;
  is_default_password: number;
}

export interface SessionListRow {
  token_hash: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  ip: string | null;
  user_agent: string | null;
}

export interface NewSession {
  tokenHash: string;
  pegawaiId: number;
  nowIso: string;
  expiresIso: string;
  ip: string | null;
  userAgent: string | null;
}

/**
 * Insert a session only while the account is not locked. Used in the login
 * batch right after `recordSuccessfulLogin`, so a lock set by a concurrent
 * failure (between reservation and success) also prevents the session.
 */
export function insertSessionIfUnlocked(db: D1Database, s: NewSession): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO sesi (token_hash, pegawai_id, created_at, expires_at, last_seen_at, ip, user_agent)
       SELECT ?1, ?2, ?3, ?4, ?3, ?5, ?6
        WHERE EXISTS (SELECT 1 FROM akun WHERE pegawai_id = ?2 AND (locked_until IS NULL OR locked_until <= ?3))`,
    )
    .bind(s.tokenHash, s.pegawaiId, s.nowIso, s.expiresIso, s.ip, s.userAgent);
}

/** Revoke every session of the user (lockout during change-password). */
export function deleteAllSessionsOf(db: D1Database, pegawaiId: number): D1PreparedStatement {
  return db.prepare(`DELETE FROM sesi WHERE pegawai_id = ?1`).bind(pegawaiId);
}

/** Delete other sessions only if the password was actually replaced by `newPasswordHash` in this batch. */
export function deleteOtherSessionsIfPasswordIs(
  db: D1Database,
  pegawaiId: number,
  keepTokenHash: string,
  newPasswordHash: string,
): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM sesi WHERE pegawai_id = ?1 AND token_hash <> ?2
          AND EXISTS (SELECT 1 FROM akun WHERE pegawai_id = ?1 AND password_hash = ?3)`,
    )
    .bind(pegawaiId, keepTokenHash, newPasswordHash);
}

/**
 * Valid session + its user in one indexed lookup. A session is valid only while
 * unexpired, the pegawai is not soft-deleted and the account is Aktif — so
 * deactivating or deleting a user takes effect on their next request.
 */
export function findSessionUser(db: D1Database, tokenHash: string, nowIso: string): Promise<SessionUserRow | null> {
  return db
    .prepare(
      `SELECT s.token_hash, s.expires_at, s.last_seen_at,
              p.id, p.nip, p.nama, p.role, p.status_kepegawaian, p.jabatan, p.foto_r2_key,
              a.is_default_password
         FROM sesi s
         JOIN pegawai p ON p.id = s.pegawai_id
         JOIN akun a ON a.pegawai_id = p.id
        WHERE s.token_hash = ?1
          AND s.expires_at > ?2
          AND p.deleted_at IS NULL
          AND p.status_akun = 'Aktif'`,
    )
    .bind(tokenHash, nowIso)
    .first<SessionUserRow>();
}

/** Sliding expiry: one write refreshes both timestamps. */
export function touchSession(db: D1Database, tokenHash: string, nowIso: string, expiresIso: string): D1PreparedStatement {
  return db
    .prepare(`UPDATE sesi SET last_seen_at = ?2, expires_at = ?3 WHERE token_hash = ?1`)
    .bind(tokenHash, nowIso, expiresIso);
}

export function deleteSession(db: D1Database, tokenHash: string): D1PreparedStatement {
  return db.prepare(`DELETE FROM sesi WHERE token_hash = ?1`).bind(tokenHash);
}

/** Delete every session of the user except `keepTokenHash`. `meta.changes` = number revoked. */
export function deleteOtherSessions(db: D1Database, pegawaiId: number, keepTokenHash: string): D1PreparedStatement {
  return db.prepare(`DELETE FROM sesi WHERE pegawai_id = ?1 AND token_hash <> ?2`).bind(pegawaiId, keepTokenHash);
}

/** Opportunistic cleanup of a user's expired sessions (the cron does the global sweep). */
export function deleteExpiredSessionsOf(db: D1Database, pegawaiId: number, nowIso: string): D1PreparedStatement {
  return db.prepare(`DELETE FROM sesi WHERE pegawai_id = ?1 AND expires_at <= ?2`).bind(pegawaiId, nowIso);
}

/** Delete one session of the user by its public id (16-hex prefix), never the current one. */
export function deleteSessionByPublicId(
  db: D1Database,
  pegawaiId: number,
  publicId: string,
  currentTokenHash: string,
): D1PreparedStatement {
  return db
    .prepare(`DELETE FROM sesi WHERE pegawai_id = ?1 AND substr(token_hash, 1, 16) = ?2 AND token_hash <> ?3`)
    .bind(pegawaiId, publicId, currentTokenHash);
}

export async function listActiveSessions(db: D1Database, pegawaiId: number, nowIso: string): Promise<SessionListRow[]> {
  const { results } = await db
    .prepare(
      `SELECT token_hash, created_at, last_seen_at, expires_at, ip, user_agent
         FROM sesi
        WHERE pegawai_id = ?1 AND expires_at > ?2
        ORDER BY last_seen_at DESC
        LIMIT 100`,
    )
    .bind(pegawaiId, nowIso)
    .all<SessionListRow>();
  return results;
}
