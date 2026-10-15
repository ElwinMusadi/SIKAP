// Middleware tested in isolation on a throwaway app — no debug routes ship in production code.
import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ApiErrorBody } from '../shared/api';
import type { AppEnv } from '../server/env';
import { csrfProtection } from '../server/middleware/csrf';
import { notFound, onError } from '../server/middleware/error-handler';
import { getAuth, requireRole, requireSession } from '../server/middleware/session';
import { parseWith } from '../server/lib/validation';
import { ORIGIN, createUser, login } from './helpers';

function testApp() {
  const app = new Hono<AppEnv>().basePath('/api');
  app.use('*', csrfProtection);
  app.get('/admin-only', requireSession, requireRole('Admin'), (c) => c.json({ ok: true, role: getAuth(c).user.role }));
  app.get('/boom', () => {
    throw new Error('SQLITE secret internals: table akun');
  });
  app.post('/zod', async (c) => {
    parseWith(z.object({ a: z.object({ b: z.string() }) }), await c.req.json());
    return c.json({ ok: true });
  });
  app.notFound(notFound);
  app.onError(onError);
  return app;
}

const req = (app: ReturnType<typeof testApp>, path: string, init: RequestInit = {}) =>
  app.request(`${ORIGIN}${path}`, init, env);

describe('requireRole', () => {
  it('blocks Pegawai with 403 FORBIDDEN', async () => {
    const user = await createUser({ role: 'Pegawai' });
    const cookie = await login(user);
    const res = await req(testApp(), '/api/admin-only', { headers: { Cookie: cookie } });
    expect(res.status).toBe(403);
    expect(((await res.json()) as ApiErrorBody).error.code).toBe('FORBIDDEN');
  });

  it('allows Admin', async () => {
    const user = await createUser({ role: 'Admin' });
    const cookie = await login(user);
    const res = await req(testApp(), '/api/admin-only', { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, role: 'Admin' });
  });

  it('requires a session first (401)', async () => {
    const res = await req(testApp(), '/api/admin-only');
    expect(res.status).toBe(401);
  });
});

describe('error handler', () => {
  it('never leaks internal error messages', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await req(testApp(), '/api/boom');
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain('SQLITE');
    expect(JSON.parse(text)).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Terjadi kesalahan pada server. Silakan coba lagi.' },
    });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('maps zod errors to 400 with dotted field paths', async () => {
    const res = await req(testApp(), '/api/zod', {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ a: { b: 1 } }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiErrorBody;
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(Object.keys(body.error.fields ?? {})).toEqual(['a.b']);
  });
});
