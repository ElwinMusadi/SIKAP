import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { Role } from '../../shared/enums';
import { AUTH_POLICY } from '../../shared/enums';
import { findSessionUser, touchSession } from '../db/sesi';
import type { AppEnv, AuthContext } from '../env';
import { clearSessionCookie, readSessionCookie, writeSessionCookie } from '../lib/cookies';
import { hashSessionToken } from '../lib/crypto';
import { errors } from '../lib/errors';
import { sessionTtlHours } from '../lib/config';
import { addHours, addMinutes, toIso } from '../lib/time';
import { rowToAuthUser } from '../services/session-user';

function sessionExpired(c: Context<AppEnv>) {
  clearSessionCookie(c);
  return c.json(errors.sessionExpired().toBody(), 401);
}

/**
 * Resolves the session cookie into `c.var.auth`. Invalid, expired, revoked,
 * deactivated or deleted → 401 SESSION_EXPIRED and the cookie is cleared.
 * Sliding expiry writes at most once per `sessionTouchIntervalMinutes`.
 */
export const requireSession = createMiddleware<AppEnv>(async (c, next) => {
  const token = readSessionCookie(c);
  if (!token) return sessionExpired(c);

  const nowMs = Date.now();
  const nowIso = toIso(nowMs);
  const tokenHash = await hashSessionToken(token);
  const row = await findSessionUser(c.env.DB, tokenHash, nowIso);
  if (!row) return sessionExpired(c);

  const touchBefore = toIso(addMinutes(nowMs, -AUTH_POLICY.sessionTouchIntervalMinutes));
  if (row.last_seen_at < touchBefore) {
    const expiresIso = toIso(addHours(nowMs, sessionTtlHours(c.env)));
    await touchSession(c.env.DB, tokenHash, nowIso, expiresIso).run();
    // Keep the browser cookie lifetime in step with the server-side expiry.
    writeSessionCookie(c, token);
  }

  const auth: AuthContext = { user: rowToAuthUser(row), tokenHash };
  c.set('auth', auth);
  await next();
});

/** Must run after `requireSession`. */
export function requireRole(...roles: Role[]) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const auth = c.get('auth');
    if (!auth) throw errors.sessionExpired();
    if (!roles.includes(auth.user.role)) throw errors.forbidden();
    await next();
  });
}

/** Typed accessor for handlers mounted behind `requireSession`. */
export function getAuth(c: Context<AppEnv>): AuthContext {
  const auth = c.get('auth');
  if (!auth) throw errors.sessionExpired();
  return auth;
}
