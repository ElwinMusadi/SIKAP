import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../server/app';
import type { AppEnv } from '../server/env';
import {
  ACCESS_JWT_HEADER,
  ACCESS_MESSAGES,
  type AccessBindings,
} from '../server/middleware/access';
import { createUser, login } from './helpers';
import type { ApiErrorBody } from '../shared/api';

const ORIGIN = 'http://localhost';
const TEAM = 'sikap-uat.cloudflareaccess.com';
const AUD = 'a'.repeat(32) + '0123456789abcdef0123456789abcdef';

type TestBindings = AppEnv['Bindings'] & AccessBindings;

function bindings(overrides: Partial<AccessBindings>): TestBindings {
  return { ...(env as AppEnv['Bindings']), ...overrides };
}

const enforced = (extra: Partial<TestBindings> = {}) =>
  bindings({ ACCESS_REQUIRED: '1', ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUDIENCE: AUD, ...extra });

async function expectError(res: Response, status: number, code: string, message?: string) {
  expect(res.status).toBe(status);
  const body = (await res.json()) as ApiErrorBody;
  expect(body.error.code).toBe(code);
  if (message) expect(body.error.message).toBe(message);
  return body;
}

const expectDenied = (res: Response) => expectError(res, 403, 'FORBIDDEN', ACCESS_MESSAGES.denied);
const expectConfig = (res: Response) => expectError(res, 503, 'INTERNAL_ERROR', ACCESS_MESSAGES.config);

const poisonedDb = new Proxy({}, {
  get(_target, prop) {
    throw new Error(`Database accessed before Access gate: ${String(prop)}`);
  },
}) as unknown as D1Database;

describe('deployment access gate: actual app enforcement', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('enforces mode 1 across read routes and mutation routes without touching DB', async () => {
    const app = createApp();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const testCases: Array<{ path: string; method?: string; body?: string }> = [
      { path: '/api/health', method: 'GET' },
      { path: '/api/ref/agama', method: 'GET' },
      { path: '/api/auth/me', method: 'GET' },
      { path: '/api/auth/login', method: 'POST', body: JSON.stringify({ nip: '199001012020011001', password: 'secret' }) },
      { path: '/api/auth/logout', method: 'POST', body: '{}' },
      { path: '/api/admin/pegawai', method: 'GET' },
      { path: '/api/admin/pegawai', method: 'POST', body: JSON.stringify({ nip: '199001012020011001' }) },
      { path: '/api/me/profile', method: 'POST', body: JSON.stringify({ email: 'test@example.com' }) },
      { path: '/api/documents/1/file', method: 'GET' },
      { path: '/api/documents/1', method: 'DELETE' },
    ];

    for (const tc of testCases) {
      const headers: Record<string, string> = {
        'CF-Connecting-IP': '203.0.113.195',
      };
      if (tc.body) {
        headers['Content-Type'] = 'application/json';
        headers['Origin'] = ORIGIN;
      }

      const res = await app.request(
        `${ORIGIN}${tc.path}`,
        {
          method: tc.method ?? 'GET',
          headers,
          body: tc.body,
        },
        enforced({ DB: poisonedDb }),
      );

      await expectDenied(res);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(['1 ', ' 1', 'true'])(
    'fails closed with 503 for invalid mode %j without DB or external calls',
    async (mode) => {
      const app = createApp();
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      const res = await app.request(
        `${ORIGIN}/api/health`,
        { method: 'GET' },
        enforced({ ACCESS_REQUIRED: mode, DB: poisonedDb }),
      );

      await expectConfig(res);
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it('rejects valid SIKAP session cookie with 403 when Access token is missing, without touching DB', async () => {
    // 1. Create a user and log in with Access mode disabled to obtain a legitimate SIKAP session cookie
    const user = await createUser({ role: 'Admin' });
    const sessionCookie = await login(user);
    expect(sessionCookie).toBeTruthy();

    const app = createApp();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    // 2. Request GET /api/auth/me with valid session cookie but with Access mode 1 enforced
    const meRes = await app.request(
      `${ORIGIN}/api/auth/me`,
      {
        method: 'GET',
        headers: {
          Cookie: sessionCookie,
          'CF-Connecting-IP': '203.0.113.50',
        },
      },
      enforced({ DB: poisonedDb }),
    );

    await expectDenied(meRes);

    // 3. Mutation POST /api/auth/logout with valid session cookie and Access mode 1 enforced
    const logoutRes = await app.request(
      `${ORIGIN}/api/auth/logout`,
      {
        method: 'POST',
        headers: {
          Cookie: sessionCookie,
          Origin: ORIGIN,
          'Content-Type': 'application/json',
          'CF-Connecting-IP': '203.0.113.50',
        },
        body: '{}',
      },
      enforced({ DB: poisonedDb }),
    );

    await expectDenied(logoutRes);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('ignores CF_Authorization cookie alone and rejects with 403 (signature strictly from header)', async () => {
    const app = createApp();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const res = await app.request(
      `${ORIGIN}/api/health`,
      {
        method: 'GET',
        headers: {
          Cookie: 'CF_Authorization=simulated.cookie.jwt.value',
          'CF-Connecting-IP': '203.0.113.88',
        },
      },
      enforced({ DB: poisonedDb }),
    );

    await expectDenied(res);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects malformed token "xxx" early without external provider/control plane fetch or DB lookup', async () => {
    const app = createApp();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const res = await app.request(
      `${ORIGIN}/api/health`,
      {
        method: 'GET',
        headers: {
          [ACCESS_JWT_HEADER]: 'xxx',
          'CF-Connecting-IP': '203.0.113.89',
        },
      },
      enforced({ DB: poisonedDb }),
    );

    await expectDenied(res);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects non-base64 ASCII simulated token without external fetch or DB lookup', async () => {
    const app = createApp();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const res = await app.request(
      `${ORIGIN}/api/health`,
      {
        method: 'GET',
        headers: {
          [ACCESS_JWT_HEADER]: 'not.valid-base64!@#.token-ascii',
          'CF-Connecting-IP': '203.0.113.90',
        },
      },
      enforced({ DB: poisonedDb }),
    );

    await expectDenied(res);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
