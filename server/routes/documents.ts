import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { DokumenItemResponse, RiwayatResponse } from '../../shared/dokumen';
import type { AppEnv } from '../env';
import { errors } from '../lib/errors';
import { requestMeta } from '../lib/request';
import { readJson } from '../lib/validation';
import { getAuth, requireSession } from '../middleware/session';
import * as dokumenService from '../services/dokumen';

/** Owner-or-Admin operations on one arsip (access rule: services/dokumen.assertCanAccessArsip). */
export const documentRoutes = new Hono<AppEnv>();

documentRoutes.use('*', requireSession);

const smallBody = bodyLimit({
  maxSize: 16 * 1024,
  onError: (c) => c.json(errors.validation(undefined, 'Ukuran permintaan terlalu besar.').toBody(), 400),
});

documentRoutes.get('/:arsipId/file', async (c) => {
  const file = await dokumenService.getDocumentFile(c.env, getAuth(c), c.req.param('arsipId'), {
    download: c.req.query('download') === '1',
    versi: c.req.query('versi'),
  });
  return c.body(file.body, 200, file.headers);
});

documentRoutes.delete('/:arsipId', smallBody, async (c) => {
  const item = await dokumenService.deleteDocument(c.env, getAuth(c), c.req.param('arsipId'), requestMeta(c));
  return c.json<DokumenItemResponse>({ item });
});

documentRoutes.post('/:arsipId/restore', smallBody, async (c) => {
  const item = await dokumenService.restoreDocument(c.env, getAuth(c), c.req.param('arsipId'), requestMeta(c));
  return c.json<DokumenItemResponse>({ item });
});

documentRoutes.post('/:arsipId/rollback', smallBody, async (c) => {
  const body = await readJson(c.req);
  const item = await dokumenService.rollbackDocument(c.env, getAuth(c), c.req.param('arsipId'), body, requestMeta(c));
  return c.json<DokumenItemResponse>({ item });
});

documentRoutes.get('/:arsipId/riwayat', async (c) => {
  const items = await dokumenService.getRiwayat(c.env, getAuth(c), c.req.param('arsipId'));
  return c.json<RiwayatResponse>({ items });
});
