import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../env';
import { errors } from '../lib/errors';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Defence in depth on top of SameSite=Strict (MIGRATION_PLAN §3.1 rule 4):
 * unsafe methods must carry an `Origin` equal to APP_URL's origin or to the
 * request's own origin (so preview deploys and localhost dev work).
 * Requests without Origin are rejected — every browser sends it on
 * cross-origin and same-origin POST/PUT/PATCH/DELETE fetches.
 */
export const csrfProtection = createMiddleware<AppEnv>(async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) return next();
  const origin = c.req.header('Origin');
  if (!origin || origin === 'null') throw errors.csrf();
  const allowed = [originOf(c.env.APP_URL), originOf(c.req.url)];
  if (!allowed.includes(origin)) throw errors.csrf();
  return next();
});
