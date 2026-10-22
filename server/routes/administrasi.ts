// Phase 7 admin routes (contract: shared/administrasi.ts). Mounted by server/app.ts
// under /api/admin, so the global CSRF check and the small /admin/* body limit apply.
import { Hono } from 'hono';
import type {
  AdminJenisDokumen,
  AdminJenisResponse,
  AdminPangkat,
  AdminRefResponse,
  AdminUnit,
  LogResponse,
} from '../../shared/administrasi';
import type { KunciApiCreateResponse, KunciApiListResponse } from '../../shared/integrasi';
import type { AppEnv } from '../env';
import { requestMeta } from '../lib/request';
import { readJson } from '../lib/validation';
import { getAuth, requireRole, requireSession } from '../middleware/session';
import * as svc from '../services/administrasi';
import * as integrasi from '../services/integrasi';

export const administrasiRoutes = new Hono<AppEnv>();

administrasiRoutes.use('*', requireSession);
administrasiRoutes.use('*', requireRole('Admin'));

administrasiRoutes.get('/log', async (c) => {
  return c.json<LogResponse>(await svc.listLog(c.env, c.req.query()));
});

administrasiRoutes.get('/ref', async (c) => {
  return c.json<AdminRefResponse>(await svc.getAdminRef(c.env));
});

administrasiRoutes.post('/ref/pangkat', async (c) => {
  const body = await readJson(c.req);
  return c.json<{ item: AdminPangkat }>(await svc.createPangkat(c.env, getAuth(c), body, requestMeta(c)), 201);
});

// `:kode` may contain '/', sent URI-encoded (III%2Fa); Hono decodes the param.
administrasiRoutes.patch('/ref/pangkat/:kode', async (c) => {
  const body = await readJson(c.req);
  return c.json<{ item: AdminPangkat }>(
    await svc.updatePangkatRef(c.env, getAuth(c), c.req.param('kode'), body, requestMeta(c)),
  );
});

administrasiRoutes.post('/ref/unit', async (c) => {
  const body = await readJson(c.req);
  return c.json<{ item: AdminUnit }>(await svc.createUnitRef(c.env, getAuth(c), body, requestMeta(c)), 201);
});

administrasiRoutes.patch('/ref/unit/:id', async (c) => {
  const body = await readJson(c.req);
  return c.json<{ item: AdminUnit }>(await svc.updateUnitRef(c.env, getAuth(c), c.req.param('id'), body, requestMeta(c)));
});

administrasiRoutes.get('/jenis-dokumen', async (c) => {
  return c.json<AdminJenisResponse>(await svc.listJenis(c.env));
});

administrasiRoutes.post('/jenis-dokumen', async (c) => {
  const body = await readJson(c.req);
  return c.json<{ item: AdminJenisDokumen }>(await svc.createJenis(c.env, getAuth(c), body, requestMeta(c)), 201);
});

administrasiRoutes.patch('/jenis-dokumen/:id', async (c) => {
  const body = await readJson(c.req);
  return c.json<{ item: AdminJenisDokumen }>(
    await svc.updateJenis(c.env, getAuth(c), c.req.param('id'), body, requestMeta(c)),
  );
});

// Integration API keys (docs/RENCANA-API-INTEGRASI.md). The plain key is only in the POST response.
administrasiRoutes.get('/kunci-api', async (c) => {
  return c.json<KunciApiListResponse>(await integrasi.listKunci(c.env));
});

administrasiRoutes.post('/kunci-api', async (c) => {
  const body = await readJson(c.req);
  return c.json<KunciApiCreateResponse>(await integrasi.createKunci(c.env, getAuth(c), body, requestMeta(c)), 201);
});

administrasiRoutes.delete('/kunci-api/:id', async (c) => {
  await integrasi.deleteKunciApi(c.env, getAuth(c), c.req.param('id'), requestMeta(c));
  return c.body(null, 204);
});
