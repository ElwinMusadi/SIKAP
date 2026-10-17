import { Hono } from 'hono';
import { createApp } from './app';
import type { AppEnv, Bindings } from './env';
import { ApiError } from './lib/errors';
import { ACCESS_MESSAGES, createAccessProtection, type AccessResolverFactory } from './middleware/access';
import { onError } from './middleware/error-handler';

/**
 * Pages advanced-mode (`_worker.js`) entry for the ISOLATED PRIVATE UAT
 * deployment ONLY. Never use it for production/main: it fails closed (503)
 * unless `ACCESS_REQUIRED` is exactly `'1'`.
 *
 * Every request passes through this worker (requires `_routes.json` to route
 * `/*` to the worker, or no `_routes.json`):
 *  - `/api` and `/api/*` go to the existing `createApp()`, whose own Access
 *    guard verifies the JWT exactly once (no second check here).
 *  - Everything else (static, SPA routes, unknown paths, any method) is gated
 *    by the same `createAccessProtection` guard BEFORE `env.ASSETS` is touched.
 * Cookies / `Cf-Access-Authenticated-User-Email` are never trusted; only a
 * signature-verified `Cf-Access-Jwt-Assertion` is accepted.
 */

export type UatBindings = Bindings & {
  /** Pages static asset binding; absent = fail closed (503). */
  ASSETS?: Fetcher;
};

export interface UatHandlerOptions {
  /**
   * Test hook: key resolver for the static guard (e.g. local JWKS). Only swaps
   * where keys come from; issuer/audience/alg/claims checks stay mandatory.
   */
  createResolver?: AccessResolverFactory;
}

const NO_STORE = 'no-store';

const configError = () => new ApiError(503, 'INTERNAL_ERROR', ACCESS_MESSAGES.config);

/** `/api`, `/api/...` only; `/apiX`, `/API`, `/%61pi` are static (and guarded). */
export function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/');
}

function modeDenied(): Response {
  return new Response(JSON.stringify(configError().toBody()), {
    status: 503,
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'Cache-Control': NO_STORE,
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function createStaticApp(options: UatHandlerOptions) {
  const app = new Hono<AppEnv>();

  // Outermost: any denial/error (guard 403/503, missing ASSETS) is never cached.
  // Successful asset responses pass through untouched (_headers still apply).
  app.use('*', async (c, next) => {
    await next();
    if (c.error) {
      c.header('Cache-Control', NO_STORE);
      c.header('X-Content-Type-Options', 'nosniff');
    }
  });
  app.use('*', createAccessProtection({ createResolver: options.createResolver }));
  app.all('*', (c) => {
    const assets = (c.env as UatBindings).ASSETS;
    if (!assets || typeof assets.fetch !== 'function') throw configError();
    return assets.fetch(c.req.raw);
  });
  app.onError(onError);
  return app;
}

export function createUatHandler(options: UatHandlerOptions = {}) {
  const api = createApp();
  const statics = createStaticApp(options);

  return {
    async fetch(request: Request, env: UatBindings, ctx?: ExecutionContext): Promise<Response> {
      // UAT-only entry: anything other than exactly '1' (absent, '0', typos) is closed.
      const { pathname } = new URL(request.url);
      const result = env.ACCESS_REQUIRED !== '1' ? modeDenied() :
        await (isApiPath(pathname) ? api.fetch(request, env, ctx) : statics.fetch(request, env, ctx));
      // Public marker identifies this all-routes guarded entry, not an auth claim.
      const response = new Response(result.body, result);
      response.headers.set('X-SIKAP-UAT-Guard', 'SIKAP_UAT_ALL_ROUTES_V1');
      return response;
    },
  } satisfies ExportedHandler<UatBindings>;
}
