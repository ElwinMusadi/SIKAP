import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppEnv } from './env';
import { errors } from './lib/errors';
import { csrfProtection } from './middleware/csrf';
import { notFound, onError } from './middleware/error-handler';
import { adminRoutes } from './routes/admin';
import { administrasiRoutes } from './routes/administrasi';
import { backupRoutes } from './routes/backup';
import { authRoutes } from './routes/auth';
import { documentRoutes } from './routes/documents';
import { healthRoutes } from './routes/health';
import { meRoutes } from './routes/me';
import { pegawaiRoutes } from './routes/pegawai';
import { refRoutes } from './routes/ref';

export const AUTH_BODY_LIMIT_BYTES = 16 * 1024;

/**
 * Build the API app. Platform-agnostic: the Pages Function entry wraps it with
 * `hono/cloudflare-pages`, tests call `app.request()` directly.
 */
export function createApp() {
  const app = new Hono<AppEnv>().basePath('/api');

  app.use('*', async (c, next) => {
    await next();
    // API responses are per-user and must never be cached by browsers or proxies,
    // unless a route opted into a private cache explicitly (ref data, photos).
    if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
  });
  app.use('*', csrfProtection);
  // JSON payloads are tiny; reject oversized bodies before parsing. Reported as
  // 400 VALIDATION_ERROR to stay within the shared ApiErrorCode contract.
  const smallBody = bodyLimit({
    maxSize: AUTH_BODY_LIMIT_BYTES,
    onError: (c) => c.json(errors.validation(undefined, 'Ukuran permintaan terlalu besar.').toBody(), 400),
  });
  app.use('/auth/*', smallBody);
  app.use('/me/profile', smallBody);
  app.use('/me/pengajuan', smallBody);
  app.use('/me/pengajuan/*', smallBody);
  app.use('/admin/*', smallBody);

  app.route('/health', healthRoutes);
  app.route('/auth', authRoutes);
  app.route('/ref', refRoutes);
  app.route('/me', meRoutes);
  app.route('/pegawai', pegawaiRoutes);
  app.route('/admin', adminRoutes);
  app.route('/admin', administrasiRoutes);
  app.route('/admin', backupRoutes);
  app.route('/documents', documentRoutes);

  app.notFound(notFound);
  app.onError(onError);
  return app;
}

export type App = ReturnType<typeof createApp>;

export const app = createApp();
export default app;
