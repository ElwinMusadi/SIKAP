import { Hono, type Context } from 'hono';
import type { AdminPengajuanListResponse, PengajuanResponse } from '../../shared/profile';
import type { DokumenListResponse } from '../../shared/dokumen';
import type {
  AccountActionResponse,
  AdminDashboardResponse,
  DeletePegawaiResponse,
  PegawaiDetailResponse,
  PegawaiListResponse,
} from '../../shared/pegawai';
import type {
  DecisionResponse,
  NotifSettings,
  TestWhatsAppResponse,
  VerifikasiQueueResponse,
  WhatsAppSettings,
} from '../../shared/verifikasi';
import type { AppEnv } from '../env';
import { errors } from '../lib/errors';
import { requestMeta } from '../lib/request';
import { readJson } from '../lib/validation';
import { getAuth, requireRole, requireSession } from '../middleware/session';
import * as dokumenService from '../services/dokumen';
import { deferBackground, flushOutbox } from '../services/notifikasi';
import * as pegawaiService from '../services/pegawai';
import * as pengajuanService from '../services/pengajuan';
import * as pengaturanService from '../services/pengaturan';
import * as verifikasiService from '../services/verifikasi';

export const adminRoutes = new Hono<AppEnv>();

adminRoutes.use('*', requireSession);
adminRoutes.use('*', requireRole('Admin'));

/** Optional JSON body: an empty body is `{}`, malformed JSON is still a 400. */
async function readOptionalJson(c: Context<AppEnv>): Promise<unknown> {
  const len = c.req.header('Content-Length');
  if (len === '0' || (!len && !c.req.header('Content-Type'))) return {};
  return readJson(c.req);
}

// ---------------------------------------------------------------------------
// Phase 6: Master Data Pegawai (contract: shared/pegawai.ts)
// ---------------------------------------------------------------------------

adminRoutes.get('/pegawai', async (c) => {
  return c.json<PegawaiListResponse>(await pegawaiService.listPegawai(c.env, c.req.query(), requestMeta(c)));
});

adminRoutes.post('/pegawai', async (c) => {
  const body = await readJson(c.req);
  return c.json<PegawaiDetailResponse>(await pegawaiService.createPegawai(c.env, getAuth(c), body, requestMeta(c)), 201);
});

adminRoutes.get('/pegawai/:id', async (c) => {
  return c.json<PegawaiDetailResponse>(await pegawaiService.getPegawaiDetail(c.env, c.req.param('id'), requestMeta(c)));
});

adminRoutes.patch('/pegawai/:id', async (c) => {
  const body = await readJson(c.req);
  return c.json<PegawaiDetailResponse>(
    await pegawaiService.updatePegawai(c.env, getAuth(c), c.req.param('id'), body, requestMeta(c)),
  );
});

adminRoutes.post('/pegawai/:id/status', async (c) => {
  const body = await readJson(c.req);
  return c.json<AccountActionResponse>(
    await pegawaiService.setStatusAkun(c.env, getAuth(c), c.req.param('id'), body, requestMeta(c)),
  );
});

adminRoutes.post('/pegawai/:id/reset-password', async (c) => {
  return c.json<AccountActionResponse>(
    await pegawaiService.resetPassword(c.env, getAuth(c), c.req.param('id'), requestMeta(c)),
  );
});

adminRoutes.post('/pegawai/:id/unlock', async (c) => {
  return c.json<AccountActionResponse>(
    await pegawaiService.unlockAccount(c.env, getAuth(c), c.req.param('id'), requestMeta(c)),
  );
});

adminRoutes.delete('/pegawai/:id', async (c) => {
  return c.json<DeletePegawaiResponse>(
    await pegawaiService.softDelete(c.env, getAuth(c), c.req.param('id'), requestMeta(c)),
  );
});

adminRoutes.post('/pegawai/:id/restore', async (c) => {
  return c.json<AccountActionResponse>(await pegawaiService.restore(c.env, getAuth(c), c.req.param('id'), requestMeta(c)));
});

adminRoutes.get('/dashboard', async (c) => {
  // Cache-Control: no-store is the app-wide default for API responses.
  return c.json<AdminDashboardResponse>(await pegawaiService.getAdminDashboard(c.env));
});

adminRoutes.get('/pegawai/:id/documents', async (c) => {
  const id = dokumenService.parseId(c.req.param('id'));
  if (id === null) throw errors.notFound('Pegawai tidak ditemukan.');
  return c.json<DokumenListResponse>(await dokumenService.listDocuments(c.env, getAuth(c).user, id));
});

adminRoutes.get('/pengajuan', async (c) => {
  return c.json<AdminPengajuanListResponse>(await pengajuanService.listAdminPengajuan(c.env, c.req.query()));
});

adminRoutes.post('/pengajuan/:id/approve', async (c) => {
  const body = await readOptionalJson(c);
  const pengajuan = await pengajuanService.approvePengajuan(c.env, getAuth(c), c.req.param('id'), body, requestMeta(c));
  return c.json<PengajuanResponse>({ pengajuan });
});

adminRoutes.post('/pengajuan/:id/reject', async (c) => {
  const body = await readJson(c.req);
  const pengajuan = await pengajuanService.rejectPengajuan(c.env, getAuth(c), c.req.param('id'), body, requestMeta(c));
  return c.json<PengajuanResponse>({ pengajuan });
});

// ---------------------------------------------------------------------------
// Phase 5: document verification queue + decisions (contract: shared/verifikasi.ts)
// ---------------------------------------------------------------------------

adminRoutes.get('/verifikasi', async (c) => {
  return c.json<VerifikasiQueueResponse>(await verifikasiService.listQueue(c.env, c.req.query()));
});

adminRoutes.post('/verifikasi/:arsipId/approve', async (c) => {
  const body = await readJson(c.req);
  const env = c.env;
  const out = await verifikasiService.approveDocument(env, getAuth(c), c.req.param('arsipId'), body, requestMeta(c));
  if (out.outboxIds.length) deferBackground(c, () => flushOutbox(env, out.outboxIds));
  return c.json<DecisionResponse>(out.response);
});

adminRoutes.post('/verifikasi/:arsipId/reject', async (c) => {
  const body = await readJson(c.req);
  const env = c.env;
  const out = await verifikasiService.rejectDocument(env, getAuth(c), c.req.param('arsipId'), body, requestMeta(c));
  if (out.outboxIds.length) deferBackground(c, () => flushOutbox(env, out.outboxIds));
  return c.json<DecisionResponse>(out.response);
});

// ---------------------------------------------------------------------------
// Phase 5: notification + WhatsApp settings
// ---------------------------------------------------------------------------

adminRoutes.get('/settings/notifications', async (c) => {
  return c.json<NotifSettings>(await pengaturanService.getNotifSettings(c.env));
});

adminRoutes.put('/settings/notifications', async (c) => {
  const body = await readJson(c.req);
  return c.json<NotifSettings>(await pengaturanService.saveNotifSettings(c.env, getAuth(c), body, requestMeta(c)));
});

adminRoutes.get('/settings/whatsapp', async (c) => {
  return c.json<WhatsAppSettings>(await pengaturanService.getWhatsAppSettings(c.env));
});

adminRoutes.put('/settings/whatsapp', async (c) => {
  const body = await readJson(c.req);
  return c.json<WhatsAppSettings>(await pengaturanService.updateWhatsAppSettings(c.env, getAuth(c), body, requestMeta(c)));
});

adminRoutes.post('/settings/whatsapp/test', async (c) => {
  return c.json<TestWhatsAppResponse>(await pengaturanService.testWhatsApp(c.env, getAuth(c), requestMeta(c)));
});
