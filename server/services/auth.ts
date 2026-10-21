// Authentication business logic: login (atomic lockout + IP throttle + audit),
// logout, change password, session management. Routes stay thin.
//
// Concurrency model (see server/db/akun.ts):
//   1. Every password verification first RESERVES an attempt with one atomic
//      UPDATE … RETURNING failed_attempts that only matches an unlocked account.
//      Parallel guesses therefore receive distinct counters, and only counters
//      1..maxFailedAttempts may run PBKDF2. Higher counters lock without hashing.
//   2. The counter reaching maxFailedAttempts on a wrong password sets the lock.
//   3. Success clears the counter only `WHERE not locked`; when that matches no
//      row (locked concurrently) no session is created and 423 is returned.
//   4. Per-IP throttle: every login attempt increments a fixed-window counter
//      with an atomic UPSERT in the same batch, and the reservation statement
//      refuses when that counter exceeds the limit. Successful logins refund
//      their hit, so the counter effectively tracks failures + in-flight
//      attempts, and an office NAT with many legitimate users is not throttled.

import { changePasswordRequestSchema, type LoginRequest, type SessionInfo } from '../../shared/api';
import { AUTH_POLICY } from '../../shared/enums';
import { defaultPasswordFor } from '../../shared/validators';
import {
  lockAccount,
  recordSuccessfulLogin,
  reserveAttemptById,
  reserveAttemptByNip,
  resetAttemptsIfUnlocked,
  selectAccountById,
  selectAccountByNip,
  updatePassword,
  type AccountRow,
  type LockRow,
  type ReservationRow,
} from '../db/akun';
import { hitRateLimit, refundRateLimit, type RateLimitRow } from '../db/rate-limit';
import {
  deleteAllSessionsOf,
  deleteExpiredSessionsOf,
  deleteOtherSessions,
  deleteOtherSessionsIfPasswordIs,
  deleteSession,
  deleteSessionByPublicId,
  insertSessionIfUnlocked,
  listActiveSessions,
} from '../db/sesi';
import type { AuthContext, AuthUser, Bindings } from '../env';
import { auditStatement, maskSubmittedNip, type AuditActor } from '../lib/audit';
import { sessionTtlHours } from '../lib/config';
import {
  generateSessionToken,
  hashPassword,
  hashSessionToken,
  sessionPublicId,
  verifyPassword,
} from '../lib/crypto';
import { ApiError, errors } from '../lib/errors';
import { addHours, addMinutes, secondsUntil, toIso } from '../lib/time';
import { parseWith } from '../lib/validation';
import { rowToAuthUser } from './session-user';

/**
 * Per-IP throttle on login attempts (in addition to the WAF rule). Counts every
 * attempt, refunds successful ones; the (limit+1)-th unrefunded attempt in the
 * window gets 429 without touching any account.
 */
export const LOGIN_IP_LIMIT = { maxAttempts: 30, windowMinutes: 15 } as const;

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
  nowMs: number;
}

function actorOf(user: Pick<AuthUser, 'id' | 'nip' | 'nama' | 'role'>): AuditActor {
  return { id: user.id, nip: user.nip, nama: user.nama, role: user.role };
}

function ipKey(ip: string): string {
  return `login-ip:${ip}`;
}

function first<T>(result: D1Result<unknown> | undefined): T | null {
  return (result?.results[0] as T | undefined) ?? null;
}

function lockedError(lockedUntil: string | null | undefined, nowMs: number): ApiError {
  const retry =
    lockedUntil && Date.parse(lockedUntil) > nowMs
      ? secondsUntil(lockedUntil, nowMs)
      : AUTH_POLICY.lockoutMinutes * 60;
  return errors.accountLocked(retry);
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

export interface LoginResult {
  user: AuthUser;
  token: string;
}

export async function login(env: Bindings, input: LoginRequest, meta: RequestMeta): Promise<LoginResult> {
  const db = env.DB;
  const nowIso = toIso(meta.nowMs);
  const windowFloorIso = toIso(addMinutes(meta.nowMs, -LOGIN_IP_LIMIT.windowMinutes));
  const rateKey = meta.ip ? ipKey(meta.ip) : null;
  const lockUntilIso = toIso(addMinutes(meta.nowMs, AUTH_POLICY.lockoutMinutes));

  // Round trip 1 (no hashing yet): count the IP hit, reserve an account
  // attempt (refused if the IP is over the limit or the account is locked),
  // then read the account state as of after the reservation.
  const stmts: D1PreparedStatement[] = [];
  if (rateKey) stmts.push(hitRateLimit(db, rateKey, nowIso, windowFloorIso));
  stmts.push(reserveAttemptByNip(db, input.nip, nowIso, rateKey, LOGIN_IP_LIMIT.maxAttempts));
  stmts.push(selectAccountByNip(db, input.nip));
  const res = await db.batch<unknown>(stmts);
  const rl = rateKey ? first<RateLimitRow>(res[0]) : null;
  const reservation = first<ReservationRow>(res[rateKey ? 1 : 0]);
  const account = first<AccountRow>(res[rateKey ? 2 : 1]);

  const audit = (actor: AuditActor, action: string, description: string, result: 'FAILURE' | 'WARNING' | 'SUCCESS') =>
    auditStatement(db, {
      ts: nowIso,
      actor,
      action,
      targetType: 'USER',
      targetId: actor.nip,
      description,
      result,
      ip: meta.ip,
    });
  const anonymous: AuditActor = { id: null, nip: maskSubmittedNip(input.nip) };
  const actor: AuditActor = account
    ? { id: account.id, nip: account.nip, nama: account.nama, role: account.role }
    : anonymous;

  if (rl && rl.count > LOGIN_IP_LIMIT.maxAttempts) {
    // Audit only the first overflow per window to bound D1 writes during an attack.
    if (rl.count === LOGIN_IP_LIMIT.maxAttempts + 1) {
      await audit(anonymous, 'LOGIN_RATE_LIMITED', 'Batas percobaan login per IP terlampaui', 'WARNING').run();
    }
    const resetIso = toIso(addMinutes(Date.parse(rl.window_start), LOGIN_IP_LIMIT.windowMinutes));
    throw errors.rateLimited(secondsUntil(resetIso, meta.nowMs));
  }

  if (!account) {
    // Unknown NIP: identical generic error. No dummy hash (CPU budget) — accepted trade-off.
    await audit(anonymous, 'LOGIN_FAILED', 'NIP tidak terdaftar', 'FAILURE').run();
    throw errors.invalidCredentials();
  }

  if (!reservation) {
    // Currently locked: refuse without hashing.
    await audit(actor, 'LOGIN_FAILED', 'Percobaan login saat akun terkunci', 'FAILURE').run();
    throw lockedError(account.locked_until, meta.nowMs);
  }

  const attempt = reservation.failed_attempts;
  if (attempt > AUTH_POLICY.maxFailedAttempts) {
    // Allowance used up by concurrent attempts still in flight: lock without hashing.
    const [lock] = await db.batch<unknown>([
      lockAccount(db, account.id, nowIso, lockUntilIso),
      audit(actor, 'ACCOUNT_LOCKED', `Akun dikunci ${AUTH_POLICY.lockoutMinutes} menit (percobaan ke-${attempt})`, 'WARNING'),
    ]);
    throw lockedError(first<LockRow>(lock)?.locked_until, meta.nowMs);
  }

  const verified = await verifyPassword(input.password, account.password_hash, env.PASSWORD_PEPPER);

  if (!verified.ok) {
    if (attempt >= AUTH_POLICY.maxFailedAttempts) {
      const [lock] = await db.batch<unknown>([
        lockAccount(db, account.id, nowIso, lockUntilIso),
        audit(actor, 'LOGIN_FAILED', 'Password salah', 'FAILURE'),
        audit(
          actor,
          'ACCOUNT_LOCKED',
          `Akun dikunci ${AUTH_POLICY.lockoutMinutes} menit setelah ${attempt} kali gagal login`,
          'WARNING',
        ),
      ]);
      throw lockedError(first<LockRow>(lock)?.locked_until, meta.nowMs);
    }
    await audit(actor, 'LOGIN_FAILED', 'Password salah', 'FAILURE').run();
    throw errors.invalidCredentials();
  }

  if (account.status_akun !== 'Aktif') {
    // Revealed only after a correct password. Counter reset: the password was right.
    await db.batch([
      resetAttemptsIfUnlocked(db, account.id, nowIso),
      audit(actor, 'LOGIN_FAILED', 'Akun nonaktif', 'FAILURE'),
    ]);
    throw errors.accountInactive();
  }

  const isDefaultPassword = input.password === defaultPasswordFor(account.nip);
  const rehashed = verified.needsRehash ? await hashPassword(input.password, env.PASSWORD_PEPPER) : null;
  const token = generateSessionToken();
  const tokenHash = await hashSessionToken(token);
  const expiresIso = toIso(addHours(meta.nowMs, sessionTtlHours(env)));

  // Round trip 2: every write is conditional on "still not locked", so a lock
  // set by a concurrent failure since our reservation wins.
  const success: D1PreparedStatement[] = [
    recordSuccessfulLogin(db, account.id, nowIso, isDefaultPassword, rehashed),
    deleteExpiredSessionsOf(db, account.id, nowIso),
    insertSessionIfUnlocked(db, {
      tokenHash,
      pegawaiId: account.id,
      nowIso,
      expiresIso,
      ip: meta.ip,
      userAgent: meta.userAgent ? meta.userAgent.slice(0, 256) : null,
    }),
    auditStatement(
      db,
      {
        ts: nowIso,
        actor,
        action: 'LOGIN',
        targetType: 'USER',
        targetId: account.nip,
        description: rehashed ? 'Login berhasil (hash password diperbarui)' : 'Login berhasil',
        result: 'SUCCESS',
        ip: meta.ip,
      },
      { onlyIfPreviousChanged: true },
    ),
  ];
  if (rateKey) success.push(refundRateLimit(db, rateKey));
  const out = await db.batch(success);

  if ((out[0]?.meta.changes ?? 0) === 0 || (out[2]?.meta.changes ?? 0) === 0) {
    const state = await selectAccountById(db, account.id).first<AccountRow>();
    await audit(actor, 'LOGIN_FAILED', 'Akun terkunci saat login diproses', 'FAILURE').run();
    throw lockedError(state?.locked_until, meta.nowMs);
  }

  return {
    token,
    user: rowToAuthUser({ ...account, is_default_password: isDefaultPassword ? 1 : 0 }),
  };
}

// ---------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------

export async function logout(env: Bindings, auth: AuthContext, meta: RequestMeta): Promise<void> {
  await env.DB.batch([
    deleteSession(env.DB, auth.tokenHash),
    auditStatement(env.DB, {
      ts: toIso(meta.nowMs),
      actor: actorOf(auth.user),
      action: 'LOGOUT',
      targetType: 'USER',
      targetId: auth.user.nip,
      description: 'Logout berhasil',
      result: 'SUCCESS',
      ip: meta.ip,
    }),
  ]);
}

// ---------------------------------------------------------------------------
// Change password
// ---------------------------------------------------------------------------

export interface ChangePasswordResult {
  user: AuthUser;
  revokedSessions: number;
}

/**
 * Wrong `currentPassword` counts toward the same account lockout as login.
 * When this request locks the account, ALL sessions (including the current
 * one) are revoked and 423 is thrown — the route clears the cookie.
 *
 * CPU: the success path runs two PBKDF2 operations (verify + new hash),
 * ≈ 8 ms on local workerd. Must be measured on a preview deploy against the
 * 10 ms Workers Free limit.
 */
export async function changePassword(
  env: Bindings,
  auth: AuthContext,
  body: unknown,
  meta: RequestMeta,
): Promise<ChangePasswordResult> {
  const db = env.DB;
  const input = parseWith(changePasswordRequestSchema(auth.user.nip), body);
  const nowIso = toIso(meta.nowMs);
  const lockUntilIso = toIso(addMinutes(meta.nowMs, AUTH_POLICY.lockoutMinutes));
  const actor = actorOf(auth.user);
  const audit = (action: string, description: string, result: 'FAILURE' | 'WARNING' | 'SUCCESS') =>
    auditStatement(db, {
      ts: nowIso,
      actor,
      action,
      targetType: 'USER',
      targetId: auth.user.nip,
      description,
      result,
      ip: meta.ip,
    });

  const [resv, acc] = await db.batch<unknown>([
    reserveAttemptById(db, auth.user.id, nowIso),
    selectAccountById(db, auth.user.id),
  ]);
  const reservation = first<ReservationRow>(resv);
  const account = first<AccountRow>(acc);
  if (!account) throw errors.sessionExpired();

  if (!reservation) {
    await audit('PASSWORD_CHANGE', 'Ditolak: akun terkunci', 'FAILURE').run();
    throw lockedError(account.locked_until, meta.nowMs);
  }

  /** Lock + revoke every session of the user, then 423. */
  const lockAndRevokeAll = async (description: string, extra: D1PreparedStatement[] = []): Promise<never> => {
    const [lock] = await db.batch<unknown>([
      lockAccount(db, auth.user.id, nowIso, lockUntilIso),
      deleteAllSessionsOf(db, auth.user.id),
      ...extra,
      audit('ACCOUNT_LOCKED', description, 'WARNING'),
    ]);
    throw lockedError(first<LockRow>(lock)?.locked_until, meta.nowMs);
  };

  const attempt = reservation.failed_attempts;
  if (attempt > AUTH_POLICY.maxFailedAttempts) {
    return lockAndRevokeAll(`Akun dikunci ${AUTH_POLICY.lockoutMinutes} menit; semua sesi dicabut (percobaan ke-${attempt})`);
  }

  const verified = await verifyPassword(input.currentPassword, account.password_hash, env.PASSWORD_PEPPER);
  if (!verified.ok) {
    const failed = audit('PASSWORD_CHANGE', 'Password saat ini salah', 'FAILURE');
    if (attempt >= AUTH_POLICY.maxFailedAttempts) {
      return lockAndRevokeAll(
        `Akun dikunci ${AUTH_POLICY.lockoutMinutes} menit setelah ${attempt} kali password salah; semua sesi dicabut`,
        [failed],
      );
    }
    await failed.run();
    throw errors.validation({ currentPassword: 'Password saat ini salah.' });
  }

  const newHash = await hashPassword(input.newPassword, env.PASSWORD_PEPPER);
  // newPasswordSchema rejects the default password, so this is always false.
  const isDefault = input.newPassword === defaultPasswordFor(auth.user.nip);

  // Every write is conditional on the update having happened (i.e. not locked concurrently).
  const stmts: D1PreparedStatement[] = [
    updatePassword(db, auth.user.id, newHash, isDefault, nowIso),
    auditStatement(
      db,
      {
        ts: nowIso,
        actor,
        action: 'PASSWORD_CHANGE',
        targetType: 'USER',
        targetId: auth.user.nip,
        description: input.revokeOtherSessions ? 'Password diubah, sesi lain dicabut' : 'Password diubah',
        result: 'SUCCESS',
        ip: meta.ip,
      },
      { onlyIfPreviousChanged: true },
    ),
  ];
  if (input.revokeOtherSessions) {
    stmts.push(deleteOtherSessionsIfPasswordIs(db, auth.user.id, auth.tokenHash, newHash));
  }
  const results = await db.batch(stmts);
  if ((results[0]?.meta.changes ?? 0) === 0) {
    const state = await selectAccountById(db, auth.user.id).first<AccountRow>();
    throw lockedError(state?.locked_until, meta.nowMs);
  }
  const revokedSessions = input.revokeOtherSessions ? (results[2]?.meta.changes ?? 0) : 0;

  return { user: { ...auth.user, isDefaultPassword: isDefault }, revokedSessions };
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

export async function listSessions(env: Bindings, auth: AuthContext, meta: RequestMeta): Promise<SessionInfo[]> {
  const rows = await listActiveSessions(env.DB, auth.user.id, toIso(meta.nowMs));
  return rows.map((r) => ({
    id: sessionPublicId(r.token_hash),
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    expiresAt: r.expires_at,
    ip: r.ip,
    userAgent: r.user_agent,
    current: r.token_hash === auth.tokenHash,
  }));
}

const SESSION_ID_RE = /^[0-9a-f]{16}$/;

export async function revokeSession(
  env: Bindings,
  auth: AuthContext,
  publicId: string,
  meta: RequestMeta,
): Promise<number> {
  if (!SESSION_ID_RE.test(publicId)) throw errors.notFound('Sesi tidak ditemukan.');
  if (publicId === sessionPublicId(auth.tokenHash)) {
    throw errors.validation({ id: 'Gunakan logout untuk mengakhiri sesi saat ini.' });
  }
  // One atomic batch; the audit row is inserted only if the DELETE matched (changes() > 0).
  const [del] = await env.DB.batch([
    deleteSessionByPublicId(env.DB, auth.user.id, publicId, auth.tokenHash),
    auditStatement(
      env.DB,
      {
        ts: toIso(meta.nowMs),
        actor: actorOf(auth.user),
        action: 'SESSION_REVOKE',
        targetType: 'SESSION',
        targetId: publicId,
        description: 'Sesi dicabut oleh pemilik akun',
        result: 'SUCCESS',
        ip: meta.ip,
      },
      { onlyIfPreviousChanged: true },
    ),
  ]);
  const revoked = del?.meta.changes ?? 0;
  if (revoked === 0) throw errors.notFound('Sesi tidak ditemukan.');
  return revoked;
}

export async function revokeOtherSessions(env: Bindings, auth: AuthContext, meta: RequestMeta): Promise<number> {
  const [del] = await env.DB.batch([
    deleteOtherSessions(env.DB, auth.user.id, auth.tokenHash),
    auditStatement(env.DB, {
      ts: toIso(meta.nowMs),
      actor: actorOf(auth.user),
      action: 'SESSION_REVOKE_OTHERS',
      targetType: 'USER',
      targetId: auth.user.nip,
      description: 'Semua sesi lain dicabut',
      result: 'SUCCESS',
      ip: meta.ip,
    }),
  ]);
  return del?.meta.changes ?? 0;
}
