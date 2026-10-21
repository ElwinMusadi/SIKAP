import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { BackupJobResponse, BackupListResponse } from '../../shared/backup';
import type { AppEnv } from '../env';
import { errors } from '../lib/errors';
import { requestMeta } from '../lib/request';
import { getAuth, requireRole, requireSession } from '../middleware/session';
import {
  createBackupJob,
  getBackupJob,
  getManifestDownload,
  getPartDownload,
  listBackups,
  stepBackup,
} from '../services/backup';

/** Mounted at /admin by app.ts. Session and role guards also cover every download. */
export const backupRoutes = new Hono<AppEnv>();
backupRoutes.use('*', requireSession);
backupRoutes.use('*', requireRole('Admin'));
backupRoutes.use('*', bodyLimit({
  maxSize: 16 * 1024,
  onError: (c) => c.json(errors.validation(undefined, 'Ukuran permintaan terlalu besar.').toBody(), 400),
}));
// CSRF is applied app-wide; POSTs accept no data, especially no client-provided table/key.
backupRoutes.get('/backup', async (c) => c.json<BackupListResponse>(await listBackups(c.env)));
backupRoutes.post('/backup', async (c) => {
  return c.json<BackupJobResponse>(await createBackupJob(c.env, getAuth(c), requestMeta(c)), 201);
});
backupRoutes.get('/backup/:id', async (c) => c.json<BackupJobResponse>(await getBackupJob(c.env, c.req.param('id'))));
backupRoutes.post('/backup/:id/step', async (c) => {
  const meta = requestMeta(c);
  return c.json<BackupJobResponse>(await stepBackup(c.env, c.req.param('id'), getAuth(c), meta.nowMs));
});
backupRoutes.get('/backup/:id/parts/:sequence', async (c) => {
  const file = await getPartDownload(c.env, c.req.param('id'), c.req.param('sequence'));
  return c.body(file.body, 200, file.headers);
});
backupRoutes.get('/backup/:id/manifest', async (c) => {
  const file = await getManifestDownload(c.env, c.req.param('id'));
  return c.body(file.body, 200, file.headers);
});
