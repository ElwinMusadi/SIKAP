import { Hono } from 'hono';
import type { RefResponse } from '../../shared/profile';
import type { AppEnv } from '../env';
import { requireSession } from '../middleware/session';
import { getRef } from '../services/profile';

export const refRoutes = new Hono<AppEnv>();

refRoutes.use('*', requireSession);

refRoutes.get('/', async (c) => {
  const data = await getRef(c.env);
  // Reference data changes rarely; short private cache (the global middleware keeps it).
  c.header('Cache-Control', 'private, max-age=300');
  return c.json<RefResponse>(data);
});
