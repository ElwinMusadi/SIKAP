import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppEnv } from './env';
import { errors } from './lib/errors';
import { csrfProtection } from './middleware/csrf';
import { notFound, onError } from './middleware/error-handler';
import { authRoutes } from './routes/auth';
import { healthRoutes } from './routes/health';

export const AUTH_BODY_LIMIT_BYTES = 16 * 1024;

/**
 * Build the API app. Platform-agnostic: the Pages Function entry wraps it with
 * `hono/cloudflare-pages`, tests call `app.request()` directly.
 */
export function createApp() {
  const app = new Hono<AppEnv>().basePath('/api');

  app.use('*', async (c, next) => {
    await next();
    // API responses are per-user and must never be cached by browsers or proxies.
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
  });
  app.use('*', csrfProtection);
  // Auth payloads are tiny; reject oversized bodies before parsing. Reported as
  // 400 VALIDATION_ERROR to stay within the shared ApiErrorCode contract.
  app.use(
    '/auth/*',
    bodyLimit({
      maxSize: AUTH_BODY_LIMIT_BYTES,
      onError: (c) => c.json(errors.validation(undefined, 'Ukuran permintaan terlalu besar.').toBody(), 400),
    }),
  );

  app.route('/health', healthRoutes);
  app.route('/auth', authRoutes);

  app.notFound(notFound);
  app.onError(onError);
  return app;
}

export type App = ReturnType<typeof createApp>;

export const app = createApp();
export default app;
