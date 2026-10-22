// Read-only integration API for other applications (contract: shared/integrasi.ts,
// guide: docs/API-INTEGRASI.md). Mounted by server/app.ts under /api/v1 on its own prefix,
// so no session middleware from the /admin sub-apps ever runs here. GET only: the global
// CSRF check rejects unsafe methods without Origin, which server-to-server callers never send.
import { Hono } from 'hono';
import type { V1PegawaiDetail, V1PegawaiListResponse, V1PingResponse } from '../../shared/integrasi';
import type { AppEnv } from '../env';
import { requestMeta } from '../lib/request';
import { apiKeyAuth, getApiClient, requireIzin } from '../middleware/api-key';
import * as svc from '../services/integrasi';

export const integrasiV1Routes = new Hono<AppEnv>();

integrasiV1Routes.use('*', apiKeyAuth);

integrasiV1Routes.get('/ping', (c) => c.json<V1PingResponse>(svc.ping(getApiClient(c))));

integrasiV1Routes.get('/pegawai', requireIzin('pegawai:baca'), async (c) => {
  return c.json<V1PegawaiListResponse>(await svc.listV1Pegawai(c.env, c.req.query()));
});

integrasiV1Routes.get('/pegawai/:nip', requireIzin('pegawai:baca'), async (c) => {
  return c.json<V1PegawaiDetail>(await svc.getV1Pegawai(c.env, getApiClient(c), c.req.param('nip'), requestMeta(c)));
});
