import { Hono } from 'hono';
import type { HealthResponse } from '../../shared/api';
import type { AppEnv } from '../env';

export const healthRoutes = new Hono<AppEnv>();

healthRoutes.get('/', async (c) => {
  let db: HealthResponse['db'] = 'ok';
  try {
    await c.env.DB.prepare('SELECT 1').first();
  } catch (err) {
    console.error('[health] D1 check failed', err);
    db = 'error';
  }
  return c.json<HealthResponse>({ status: 'ok', time: new Date().toISOString(), db }, db === 'ok' ? 200 : 503);
});
