// SQL for pegawai + akun as used by authentication. Thin, prepared statements only.
//
// Lockout model (MIGRATION_PLAN §3.1, AUTH_POLICY): every password verification
// must first RESERVE an attempt with an atomic UPDATE that only succeeds while
// the account is not locked. The reservation returns the post-increment counter,
// so N concurrent guesses get distinct counters 1..N and at most
// `maxFailedAttempts` of them are ever allowed to run PBKDF2 per lock window.
// Success paths reset the counter only `WHERE <not locked>`, so a correct
// password can never clear a lock set by concurrent failures.

import type { Role, StatusAkun, StatusKepegawaian } from '../../shared/enums';

/** pegawai JOIN akun, the fields auth needs. */
export interface AccountRow {
  id: number;
  nip: string;
  nama: string;
  role: Role;
  status_akun: StatusAkun;
  status_kepegawaian: StatusKepegawaian | null;
  jabatan: string | null;
  foto_r2_key: string | null;
  password_hash: string;
  is_default_password: number;
  failed_attempts: number;
  locked_until: string | null;
}

export interface ReservationRow {
  failed_attempts: number;
}

export interface LockRow {
  locked_until: string;
}

const ACCOUNT_COLUMNS = `p.id, p.nip, p.nama, p.role, p.status_akun, p.status_kepegawaian, p.jabatan, p.foto_r2_key,
  a.password_hash, a.is_default_password, a.failed_attempts, a.locked_until`;

/** SQL fragment: account is not currently locked. `?N` must bind the current ISO time. */
const notLocked = (nowParam: string) => `(locked_until IS NULL OR locked_until <= ${nowParam})`;

/** Active (not soft-deleted) account by NIP. */
export function selectAccountByNip(db: D1Database, nip: string): D1PreparedStatement {
  return db
    .prepare(
      `SELECT ${ACCOUNT_COLUMNS}
         FROM pegawai p JOIN akun a ON a.pegawai_id = p.id
        WHERE p.nip = ?1 AND p.deleted_at IS NULL`,
    )
    .bind(nip);
}

export function selectAccountById(db: D1Database, id: number): D1PreparedStatement {
  return db
    .prepare(
      `SELECT ${ACCOUNT_COLUMNS}
         FROM pegawai p JOIN akun a ON a.pegawai_id = p.id
        WHERE p.id = ?1 AND p.deleted_at IS NULL`,
    )
    .bind(id);
}

/**
 * Reserve one login attempt for `nip`. Returns a row `{ failed_attempts }`
 * (post-increment) only when the account exists, is not locked, and the
 * per-IP counter `rateKey` (already incremented earlier in the same batch)
 * is within `rateLimit`. An expired lock restarts the counter at 1.
 */
export function reserveAttemptByNip(
  db: D1Database,
  nip: string,
  nowIso: string,
  rateKey: string | null,
  rateLimit: number,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE akun SET
         failed_attempts = CASE WHEN locked_until IS NOT NULL THEN 1 ELSE failed_attempts + 1 END,
         locked_until = NULL
       WHERE pegawai_id = (SELECT id FROM pegawai WHERE nip = ?1 AND deleted_at IS NULL)
         AND ${notLocked('?2')}
         AND COALESCE((SELECT count FROM rate_limit WHERE key = ?3), 0) <= ?4
       RETURNING failed_attempts`,
    )
    .bind(nip, nowIso, rateKey, rateLimit);
}

/** Same reservation for an authenticated user (change-password). */
export function reserveAttemptById(db: D1Database, pegawaiId: number, nowIso: string): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE akun SET
         failed_attempts = CASE WHEN locked_until IS NOT NULL THEN 1 ELSE failed_attempts + 1 END,
         locked_until = NULL
       WHERE pegawai_id = ?1 AND ${notLocked('?2')}
       RETURNING failed_attempts`,
    )
    .bind(pegawaiId, nowIso);
}

/** Lock the account until `lockUntilIso`; an already-active lock is kept. Always returns the effective lock. */
export function lockAccount(db: D1Database, pegawaiId: number, nowIso: string, lockUntilIso: string): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE akun SET
         locked_until = CASE WHEN locked_until IS NOT NULL AND locked_until > ?2 THEN locked_until ELSE ?3 END
       WHERE pegawai_id = ?1
       RETURNING locked_until`,
    )
    .bind(pegawaiId, nowIso, lockUntilIso);
}

/** Correct password on an account that may not log in (e.g. Nonaktif): just clear the counter. */
export function resetAttemptsIfUnlocked(db: D1Database, pegawaiId: number, nowIso: string): D1PreparedStatement {
  return db
    .prepare(`UPDATE akun SET failed_attempts = 0 WHERE pegawai_id = ?1 AND ${notLocked('?2')}`)
    .bind(pegawaiId, nowIso);
}

/**
 * Successful login: clear the counter, stamp login time, persist the
 * default-password flag and optionally replace the hash. `meta.changes = 0`
 * means a concurrent failure locked the account — the caller must refuse.
 */
export function recordSuccessfulLogin(
  db: D1Database,
  pegawaiId: number,
  nowIso: string,
  isDefaultPassword: boolean,
  newPasswordHash: string | null,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE akun SET
         failed_attempts = 0,
         locked_until = NULL,
         last_login_at = ?2,
         is_default_password = ?3,
         password_hash = COALESCE(?4, password_hash)
       WHERE pegawai_id = ?1 AND ${notLocked('?2')}`,
    )
    .bind(pegawaiId, nowIso, isDefaultPassword ? 1 : 0, newPasswordHash);
}

/** Set a new password and clear the counter, unless locked concurrently (`meta.changes = 0`). */
export function updatePassword(
  db: D1Database,
  pegawaiId: number,
  passwordHash: string,
  isDefaultPassword: boolean,
  nowIso: string,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE akun SET
         password_hash = ?2,
         is_default_password = ?3,
         password_changed_at = ?4,
         failed_attempts = 0,
         locked_until = NULL
       WHERE pegawai_id = ?1 AND ${notLocked('?4')}`,
    )
    .bind(pegawaiId, passwordHash, isDefaultPassword ? 1 : 0, nowIso);
}
