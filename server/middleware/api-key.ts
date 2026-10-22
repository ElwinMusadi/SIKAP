import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { IzinApi } from '../../shared/integrasi';
import type { ApiClient, AppEnv } from '../env';
import { ApiError, errors } from '../lib/errors';
import { requestMeta } from '../lib/request';
import { authenticateApiKey } from '../services/integrasi';

/**
 * Resolves `Authorization: Bearer skp_…` into `c.var.apiClient` for /api/v1. No cookies,
 * no session: integration clients call server-to-server. 401 answers carry
 * `WWW-Authenticate: Bearer` so HTTP clients recognise the scheme.
 */
export const apiKeyAuth = createMiddleware<AppEnv>(async (c, next) => {
  try {
    c.set('apiClient', await authenticateApiKey(c.env, c.req.header('Authorization'), requestMeta(c)));
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) c.header('WWW-Authenticate', 'Bearer realm="SIKAP"');
    throw err;
  }
  await next();
});

/** Must run after `apiKeyAuth`. */
export function requireIzin(izin: IzinApi) {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (!getApiClient(c).izin.includes(izin)) throw errors.apiScopeDenied();
    await next();
  });
}

/** Typed accessor for handlers mounted behind `apiKeyAuth`. */
export function getApiClient(c: Context<AppEnv>): ApiClient {
  const client = c.get('apiClient');
  if (!client) throw errors.apiKeyInvalid();
  return client;
}
