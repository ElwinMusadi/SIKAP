import type { Context } from 'hono';
import type { AppEnv } from '../env';
import type { RequestMeta } from '../services/auth';

/** Client metadata for audit/session rows. CF-Connecting-IP is set by Cloudflare's edge. */
export function requestMeta(c: Context<AppEnv>): RequestMeta {
  const ip = c.req.header('CF-Connecting-IP')?.trim() || null;
  const ua = c.req.header('User-Agent') ?? null;
  return {
    ip: ip ? ip.slice(0, 64) : null,
    userAgent: ua ? ua.slice(0, 256) : null,
    nowMs: Date.now(),
  };
}
