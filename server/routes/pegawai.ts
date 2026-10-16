import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { requireSession } from '../middleware/session';
import { getPhoto } from '../services/profile';

export const pegawaiRoutes = new Hono<AppEnv>();

pegawaiRoutes.use('*', requireSession);

// Any signed-in user may view the photo of any non-deleted pegawai, matching
// the legacy app (photos are shown in lists visible to every employee).
pegawaiRoutes.get('/:id/photo', async (c) => {
  const result = await getPhoto(c.env, c.req.param('id'), c.req.raw.headers);
  const cacheHeaders = { 'Cache-Control': 'private, max-age=86400' };
  if (result.kind === 'not-modified') {
    return c.body(null, 304, { ...cacheHeaders, ETag: result.etag });
  }
  const { obj } = result;
  return c.body(obj.body, 200, {
    ...cacheHeaders,
    'Content-Type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
    ETag: obj.httpEtag,
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    'X-Content-Type-Options': 'nosniff',
  });
});
