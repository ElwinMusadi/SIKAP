import { Hono } from 'hono';
import {
  loginRequestSchema,
  type ChangePasswordResponse,
  type LoginResponse,
  type MeResponse,
  type RevokeSessionsResponse,
  type SessionsResponse,
} from '../../shared/api';
import type { AppEnv } from '../env';
import { clearSessionCookie, writeSessionCookie } from '../lib/cookies';
import { ApiError } from '../lib/errors';
import { requestMeta } from '../lib/request';
import { parseWith, readJson } from '../lib/validation';
import { getAuth, requireSession } from '../middleware/session';
import * as authService from '../services/auth';
import { toSessionUser } from '../services/session-user';

export const authRoutes = new Hono<AppEnv>();

authRoutes.post('/login', async (c) => {
  const input = parseWith(loginRequestSchema, await readJson(c.req));
  const { user, token } = await authService.login(c.env, input, requestMeta(c));
  writeSessionCookie(c, token);
  return c.json<LoginResponse>({ user: toSessionUser(user) });
});

// Everything below requires a valid session.
authRoutes.use('/logout', requireSession);
authRoutes.use('/me', requireSession);
authRoutes.use('/change-password', requireSession);
authRoutes.use('/sessions', requireSession);
authRoutes.use('/sessions/*', requireSession);

authRoutes.post('/logout', async (c) => {
  await authService.logout(c.env, getAuth(c), requestMeta(c));
  clearSessionCookie(c);
  return c.body(null, 204);
});

authRoutes.get('/me', (c) => {
  return c.json<MeResponse>({ user: toSessionUser(getAuth(c).user) });
});

authRoutes.post('/change-password', async (c) => {
  let result: authService.ChangePasswordResult;
  try {
    result = await authService.changePassword(c.env, getAuth(c), await readJson(c.req), requestMeta(c));
  } catch (err) {
    // Lockout revoked every session, including this one.
    if (err instanceof ApiError && err.code === 'ACCOUNT_LOCKED') clearSessionCookie(c);
    throw err;
  }
  return c.json<ChangePasswordResponse>({
    user: toSessionUser(result.user),
    revokedSessions: result.revokedSessions,
  });
});

authRoutes.get('/sessions', async (c) => {
  const sessions = await authService.listSessions(c.env, getAuth(c), requestMeta(c));
  return c.json<SessionsResponse>({ sessions });
});

authRoutes.post('/sessions/revoke-others', async (c) => {
  const revoked = await authService.revokeOtherSessions(c.env, getAuth(c), requestMeta(c));
  return c.json<RevokeSessionsResponse>({ revoked });
});

authRoutes.delete('/sessions/:id', async (c) => {
  const revoked = await authService.revokeSession(c.env, getAuth(c), c.req.param('id'), requestMeta(c));
  return c.json<RevokeSessionsResponse>({ revoked });
});
