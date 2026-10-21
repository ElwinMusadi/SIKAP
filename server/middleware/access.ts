import { createMiddleware } from 'hono/factory';
import type { MiddlewareHandler } from 'hono';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { AppEnv } from '../env';
import { ApiError } from '../lib/errors';

/**
 * Server-side Cloudflare Access JWT guard for an isolated private UAT deployment.
 *
 * The normal Pages app mounts this on `/api/*`. The UAT advanced entry also
 * mounts it before static assets. Edge Access must still cover all deployment
 * hostnames; this code alone is NOT a global privacy guarantee. It never replaces SIKAP's
 * own session auth — a valid Access token only lets the request reach the
 * normal (session/CSRF/role-checked) pipeline.
 *
 * Docs: developers.cloudflare.com/cloudflare-one/access-controls/applications/
 * http-apps/authorization-cookie/validating-json/ — `Cf-Access-Jwt-Assertion`
 * header, RS256, keys from `https://<team>/cdn-cgi/access/certs`,
 * `iss` = `https://<team>`, `aud` = application AUD tag.
 */

/** Optional bindings read by this guard (declared by the lead in `env.ts`). */
export interface AccessBindings {
  /** `undefined` / `'0'` = off, `'1'` = enforced, anything else = fail closed. */
  ACCESS_REQUIRED?: string;
  /** Plain team host, e.g. `sikap-uat.cloudflareaccess.com` (no scheme/path). */
  ACCESS_TEAM_DOMAIN?: string;
  /** Access application AUD tag: 64 lowercase hex chars. */
  ACCESS_AUDIENCE?: string;
}

export const ACCESS_JWT_HEADER = 'Cf-Access-Jwt-Assertion';
export const ACCESS_TOKEN_MAX_BYTES = 16 * 1024;
export const ACCESS_CLOCK_TOLERANCE_SECONDS = 5;
const RESOLVER_CACHE_MAX = 8;

export const ACCESS_MESSAGES = {
  config: 'Konfigurasi akses privat tidak valid.',
  denied: 'Akses staging memerlukan autentikasi tambahan.',
} as const;

const TEAM_DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/;
const AUDIENCE_RE = /^[0-9a-f]{64}$/;
const COMPACT_JWS_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

const configError = () => new ApiError(503, 'INTERNAL_ERROR', ACCESS_MESSAGES.config);
const denied = () => new ApiError(403, 'FORBIDDEN', ACCESS_MESSAGES.denied);

/** Builds a key resolver for the fixed, validated team certs URL. */
export type AccessResolverFactory = (certsUrl: URL) => JWTVerifyGetKey;

export const defaultAccessResolverFactory: AccessResolverFactory = (certsUrl) =>
  createRemoteJWKSet(certsUrl, {
    timeoutDuration: 5_000,
    cooldownDuration: 30_000,
    cacheMaxAge: 10 * 60_000,
  });

export interface AccessProtectionOptions {
  /** Test hook: inject a local key set instead of fetching remote certs. */
  createResolver?: AccessResolverFactory;
}

export function createAccessProtection(options: AccessProtectionOptions = {}): MiddlewareHandler<AppEnv> {
  const createResolver = options.createResolver ?? defaultAccessResolverFactory;
  // Keyed by trusted runtime config (validated team domain), never request data.
  // Bounded so per-test env overrides cannot grow it unboundedly.
  const resolvers = new Map<string, JWTVerifyGetKey>();

  const resolverFor = (teamDomain: string): JWTVerifyGetKey => {
    const cached = resolvers.get(teamDomain);
    if (cached) return cached;
    const resolver = createResolver(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
    if (resolvers.size >= RESOLVER_CACHE_MAX) {
      const oldest = resolvers.keys().next().value;
      if (oldest !== undefined) resolvers.delete(oldest);
    }
    resolvers.set(teamDomain, resolver);
    return resolver;
  };

  return createMiddleware<AppEnv>(async (c, next) => {
    const env = c.env as AppEnv['Bindings'] & AccessBindings;
    const mode = env.ACCESS_REQUIRED;
    if (mode === undefined || mode === '0') return next();
    if (mode !== '1') throw configError();

    const teamDomain = env.ACCESS_TEAM_DOMAIN;
    const audience = env.ACCESS_AUDIENCE;
    if (typeof teamDomain !== 'string' || !TEAM_DOMAIN_RE.test(teamDomain)) throw configError();
    if (typeof audience !== 'string' || !AUDIENCE_RE.test(audience)) throw configError();

    const token = c.req.header(ACCESS_JWT_HEADER);
    if (!token || token.length > ACCESS_TOKEN_MAX_BYTES || !COMPACT_JWS_RE.test(token)) throw denied();

    try {
      await jwtVerify(token, resolverFor(teamDomain), {
        algorithms: ['RS256'],
        issuer: `https://${teamDomain}`,
        audience,
        requiredClaims: ['iss', 'aud', 'exp', 'iat'],
        clockTolerance: ACCESS_CLOCK_TOLERANCE_SECONDS,
      });
    } catch {
      // Signature/claim failures and JWKS fetch failures are all reported as the
      // same generic 403; nothing about the token or config is echoed or logged.
      throw denied();
    }
    return next();
  });
}

/** Production guard (remote JWKS, module-level bounded resolver cache). */
export const accessProtection: MiddlewareHandler<AppEnv> = createAccessProtection();
