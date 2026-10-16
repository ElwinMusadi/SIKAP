import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  PHOTO_POLICY,
  type DashboardResponse,
  type PengajuanListResponse,
  type PengajuanResponse,
  type PhotoResponse,
  type ProfileResponse,
} from '../../shared/profile';
import type { AppEnv } from '../env';
import { errors } from '../lib/errors';
import { requestMeta } from '../lib/request';
import { readJson } from '../lib/validation';
import { getAuth, requireSession } from '../middleware/session';
import * as pengajuanService from '../services/pengajuan';
import * as profileService from '../services/profile';

export const PHOTO_BODY_LIMIT_BYTES = PHOTO_POLICY.maxBytes + 64 * 1024;

export const meRoutes = new Hono<AppEnv>();

meRoutes.use('*', requireSession);

meRoutes.get('/profile', async (c) => {
  return c.json<ProfileResponse>(await profileService.getProfile(c.env, getAuth(c)));
});

meRoutes.patch('/profile', async (c) => {
  const body = await readJson(c.req);
  return c.json<ProfileResponse>(await profileService.updateProfile(c.env, getAuth(c), body, requestMeta(c)));
});

meRoutes.put(
  '/photo',
  bodyLimit({
    maxSize: PHOTO_BODY_LIMIT_BYTES,
    onError: (c) =>
      c.json(errors.validation({ file: 'Ukuran foto maksimal 2 MB.' }, 'Ukuran permintaan terlalu besar.').toBody(), 400),
  }),
  async (c) => {
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      throw errors.validation({ file: 'File foto wajib diunggah.' });
    }
    const file = form.get('file');
    return c.json<PhotoResponse>(await profileService.uploadPhoto(c.env, getAuth(c), file, requestMeta(c)));
  },
);

meRoutes.get('/dashboard', async (c) => {
  return c.json<DashboardResponse>(await profileService.getDashboard(c.env, getAuth(c)));
});

// Pengajuan perubahan data kepegawaian (owner decision #6).
meRoutes.get('/pengajuan', async (c) => {
  return c.json<PengajuanListResponse>({ items: await pengajuanService.listOwnPengajuan(c.env, getAuth(c)) });
});

meRoutes.post('/pengajuan', async (c) => {
  const body = await readJson(c.req);
  const pengajuan = await pengajuanService.createPengajuan(c.env, getAuth(c), body, requestMeta(c));
  return c.json<PengajuanResponse>({ pengajuan }, 201);
});

meRoutes.delete('/pengajuan/:id', async (c) => {
  const pengajuan = await pengajuanService.cancelOwnPengajuan(c.env, getAuth(c), c.req.param('id'), requestMeta(c));
  return c.json<PengajuanResponse>({ pengajuan });
});
