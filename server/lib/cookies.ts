import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppEnv } from '../env';
import { sessionTtlHours } from './config';

/**
 * `__Host-` requires Secure, which browsers refuse on http://localhost, so
 * plain-HTTP dev uses an unprefixed name. Production is always HTTPS.
 */
export const SECURE_COOKIE_NAME = '__Host-sikap_sid';
export const DEV_COOKIE_NAME = 'sikap_sid';

function isHttps(c: Context<AppEnv>): boolean {
  return new URL(c.req.url).protocol === 'https:';
}

export function sessionCookieName(c: Context<AppEnv>): string {
  return isHttps(c) ? SECURE_COOKIE_NAME : DEV_COOKIE_NAME;
}

export function readSessionCookie(c: Context<AppEnv>): string | undefined {
  const value = getCookie(c, sessionCookieName(c));
  // Tokens are 32 bytes base64url (43 chars); reject anything else before hashing.
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
}

export function writeSessionCookie(c: Context<AppEnv>, token: string): void {
  const secure = isHttps(c);
  setCookie(c, sessionCookieName(c), token, {
    httpOnly: true,
    secure,
    sameSite: 'Strict',
    path: '/',
    maxAge: Math.floor(sessionTtlHours(c.env) * 3600),
  });
}

export function clearSessionCookie(c: Context<AppEnv>): void {
  const secure = isHttps(c);
  deleteCookie(c, sessionCookieName(c), { path: '/', secure, httpOnly: true, sameSite: 'Strict' });
}
