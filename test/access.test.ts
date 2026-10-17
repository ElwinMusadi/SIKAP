import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK, type JWTVerifyGetKey } from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ApiErrorBody } from '../shared/api';
import type { AppEnv } from '../server/env';
import {
  ACCESS_JWT_HEADER,
  ACCESS_MESSAGES,
  accessProtection,
  createAccessProtection,
  type AccessBindings,
} from '../server/middleware/access';
import { csrfProtection } from '../server/middleware/csrf';
import { notFound, onError } from '../server/middleware/error-handler';
import { authRoutes } from '../server/routes/auth';
import { healthRoutes } from '../server/routes/health';
import { createApp } from '../server/app';

const ORIGIN = 'http://localhost';
const TEAM = 'sikap-uat.cloudflareaccess.com';
const AUD = 'a'.repeat(32) + '0123456789abcdef0123456789abcdef';
const KID = 'test-key-1';

type TestBindings = AppEnv['Bindings'] & AccessBindings;
type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;

let good: KeyPair;
let other: KeyPair;
let localJwks: JWTVerifyGetKey;

beforeAll(async () => {
  good = await generateKeyPair('RS256', { extractable: true });
  other = await generateKeyPair('RS256', { extractable: true });
  const jwk: JWK = { ...(await exportJWK(good.publicKey)), kid: KID, alg: 'RS256', use: 'sig' };
  localJwks = createLocalJWKSet({ keys: [jwk] });
});

afterEach(() => vi.restoreAllMocks());

/** Per-test bindings override; never mutates the shared `env`. */
function bindings(overrides: Partial<AccessBindings>): TestBindings {
  return { ...(env as AppEnv['Bindings']), ...overrides };
}

const enforced = (extra: Partial<AccessBindings> = {}) =>
  bindings({ ACCESS_REQUIRED: '1', ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUDIENCE: AUD, ...extra });

/** Mirrors the intended production order: Access gate, then CSRF, then routes. */
function buildApp(createResolver = vi.fn((_url: URL) => localJwks)) {
  const app = new Hono<AppEnv>().basePath('/api');
  app.use('*', createAccessProtection({ createResolver }));
  app.use('*', csrfProtection);
  app.route('/health', healthRoutes);
  app.route('/auth', authRoutes);
  app.notFound(notFound);
  app.onError(onError);
  return { app, createResolver };
}

interface ReqOpts {
  method?: string;
  token?: string;
  origin?: string;
  body?: BodyInit;
  headers?: Record<string, string>;
}

function request(app: Hono<AppEnv>, path: string, b: TestBindings, opts: ReqOpts = {}) {
  const headers: Record<string, string> = { 'CF-Connecting-IP': '203.0.113.9', ...opts.headers };
  if (opts.token !== undefined) headers[ACCESS_JWT_HEADER] = opts.token;
  if (opts.origin) headers['Origin'] = opts.origin;
  return app.request(`${ORIGIN}${path}`, { method: opts.method ?? 'GET', headers, body: opts.body }, b);
}

async function sign(
  opts: {
    key?: CryptoKey;
    iss?: string;
    aud?: string;
    exp?: number | null;
    iat?: number | null;
    nbf?: number;
  } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const jwt = new SignJWT({ email: 'tester@example.invalid', type: 'app' })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(opts.iss ?? `https://${TEAM}`)
    .setAudience(opts.aud ?? AUD)
    .setSubject('synthetic-subject');
  if (opts.iat !== null) jwt.setIssuedAt(opts.iat ?? now);
  if (opts.exp !== null) jwt.setExpirationTime(opts.exp ?? now + 300);
  if (opts.nbf !== undefined) jwt.setNotBefore(opts.nbf);
  return jwt.sign(opts.key ?? good.privateKey);
}

async function expectError(res: Response, status: number, code: string, message?: string) {
  expect(res.status).toBe(status);
  const body = (await res.json()) as ApiErrorBody;
  expect(body.error.code).toBe(code);
  if (message) expect(body.error.message).toBe(message);
  return body;
}

const expectDenied = (res: Response) => expectError(res, 403, 'FORBIDDEN', ACCESS_MESSAGES.denied);
const expectConfig = (res: Response) => expectError(res, 503, 'INTERNAL_ERROR', ACCESS_MESSAGES.config);

describe('actual application Access boundary', () => {
  it('blocks every API surface in enforced mode before session or body work', async () => {
    const app = createApp();
    const fetch = vi.spyOn(globalThis, 'fetch');
    for (const path of ['/api/health', '/api/auth/me', '/api/admin/pegawai', '/api/documents/1/file']) {
      const res = await app.request(`http://localhost${path}`, {}, enforced());
      await expectDenied(res);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    const login = await app.request('http://localhost/api/auth/login', {
      method: 'POST', headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' }, body: '{invalid',
    }, enforced());
    await expectDenied(login);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('actual app remains compatible with explicitly disabled/default mode', async () => {
    const res = await createApp().request('http://localhost/api/health', {}, bindings({ ACCESS_REQUIRED: '0' }));
    expect(res.status).toBe(200);
  });
});

describe('access guard: mode', () => {
  it('is a no-op when ACCESS_REQUIRED is absent or "0" (health 200, no resolver, no fetch)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { app, createResolver } = buildApp();
    expect((await request(app, '/api/health', bindings({}))).status).toBe(200);
    expect((await request(app, '/api/health', bindings({ ACCESS_REQUIRED: '0' }))).status).toBe(200);
    expect(createResolver).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('default production export also passes when mode is absent', async () => {
    const app = new Hono<AppEnv>().basePath('/api');
    app.use('*', accessProtection);
    app.route('/health', healthRoutes);
    app.onError(onError);
    expect((await request(app, '/api/health', bindings({}))).status).toBe(200);
  });

  it.each(['', 'true', 'yes', '2', ' 1', '1 ', 'on', 'false', '00'])(
    'fails closed with 503 for invalid mode %j',
    async (mode) => {
      const { app, createResolver } = buildApp();
      await expectConfig(await request(app, '/api/health', enforced({ ACCESS_REQUIRED: mode }), { token: await sign() }));
      expect(createResolver).not.toHaveBeenCalled();
    },
  );
});

describe('access guard: configuration', () => {
  it('503 when team domain or audience is missing, even without a token', async () => {
    const { app, createResolver } = buildApp();
    await expectConfig(await request(app, '/api/health', bindings({ ACCESS_REQUIRED: '1', ACCESS_AUDIENCE: AUD })));
    await expectConfig(await request(app, '/api/health', bindings({ ACCESS_REQUIRED: '1', ACCESS_TEAM_DOMAIN: TEAM })));
    await expectConfig(await request(app, '/api/health', bindings({ ACCESS_REQUIRED: '1' })));
    expect(createResolver).not.toHaveBeenCalled();
  });

  it.each([
    'https://sikap-uat.cloudflareaccess.com',
    'sikap-uat.cloudflareaccess.com/',
    'sikap-uat.cloudflareaccess.com/cdn-cgi/access/certs',
    'evil.example.com',
    '169.254.169.254',
    'localhost',
    'sikap-uat.cloudflareaccess.com.evil.example',
    'evil.example/.cloudflareaccess.com',
    'user@sikap-uat.cloudflareaccess.com',
    'sikap-uat.cloudflareaccess.com:8443',
    'SIKAP-UAT.cloudflareaccess.com',
    'a.b.cloudflareaccess.com',
    '-bad.cloudflareaccess.com',
    '.cloudflareaccess.com',
    ' sikap-uat.cloudflareaccess.com',
  ])('rejects malformed team domain %j with 503 and never builds a resolver or fetches', async (team) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { app, createResolver } = buildApp();
    await expectConfig(
      await request(app, '/api/health', enforced({ ACCESS_TEAM_DOMAIN: team }), { token: await sign() }),
    );
    expect(createResolver).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(['', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), `${'a'.repeat(63)} `])(
    'rejects malformed audience %j with 503',
    async (aud) => {
      const { app, createResolver } = buildApp();
      await expectConfig(await request(app, '/api/health', enforced({ ACCESS_AUDIENCE: aud }), { token: await sign() }));
      expect(createResolver).not.toHaveBeenCalled();
    },
  );

  it('builds the resolver only for the fixed certs URL of the validated team', async () => {
    const { app, createResolver } = buildApp();
    expect((await request(app, '/api/health', enforced(), { token: await sign() })).status).toBe(200);
    expect(createResolver).toHaveBeenCalledTimes(1);
    expect(createResolver.mock.calls[0]?.[0].href).toBe(`https://${TEAM}/cdn-cgi/access/certs`);
  });

  it('caches one resolver per team domain and bounds the cache', async () => {
    const { app, createResolver } = buildApp();
    const b = enforced();
    await request(app, '/api/health', b, { token: await sign() });
    await request(app, '/api/health', b, { token: await sign() });
    expect(createResolver).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 8; i++) {
      // Wrong issuer for these teams is fine; only resolver creation is counted.
      await request(app, '/api/health', enforced({ ACCESS_TEAM_DOMAIN: `team${i}.cloudflareaccess.com` }), {
        token: await sign(),
      });
    }
    expect(createResolver).toHaveBeenCalledTimes(9);
    // Original team was evicted (max 8 entries), so it is rebuilt.
    await request(app, '/api/health', b, { token: await sign() });
    expect(createResolver).toHaveBeenCalledTimes(10);
  });
});

describe('access guard: token verification', () => {
  it('403 without the assertion header (cookie/email headers are not trusted)', async () => {
    const { app } = buildApp();
    const token = await sign();
    await expectDenied(await request(app, '/api/health', enforced()));
    await expectDenied(
      await request(app, '/api/health', enforced(), {
        headers: {
          Cookie: `CF_Authorization=${token}`,
          'Cf-Access-Authenticated-User-Email': 'tester@example.invalid',
        },
      }),
    );
  });

  it('403 for empty, oversized, or non-compact tokens', async () => {
    const { app, createResolver } = buildApp();
    await expectDenied(await request(app, '/api/health', enforced(), { token: '' }));
    await expectDenied(await request(app, '/api/health', enforced(), { token: `a.${'b'.repeat(17 * 1024)}.c` }));
    await expectDenied(await request(app, '/api/health', enforced(), { token: 'not-a-jwt' }));
    await expectDenied(await request(app, '/api/health', enforced(), { token: `Bearer ${await sign()}` }));
    expect(createResolver).not.toHaveBeenCalled();
  });

  it('403 for alg none and HS256 tokens', async () => {
    const { app } = buildApp();
    const enc = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    const now = Math.floor(Date.now() / 1000);
    const claims = { iss: `https://${TEAM}`, aud: AUD, iat: now, exp: now + 300 };
    await expectDenied(
      await request(app, '/api/health', enforced(), { token: `${enc({ alg: 'none' })}.${enc(claims)}.` }),
    );
    await expectDenied(
      await request(app, '/api/health', enforced(), { token: `${enc({ alg: 'none' })}.${enc(claims)}.AAAA` }),
    );
    const hs = await new SignJWT(claims)
      .setProtectedHeader({ alg: 'HS256', kid: KID })
      .sign(new TextEncoder().encode('x'.repeat(32)));
    await expectDenied(await request(app, '/api/health', enforced(), { token: hs }));
  });

  it('403 for bad signature, wrong audience, wrong issuer, expired, future nbf, missing exp/iat', async () => {
    const { app } = buildApp();
    const now = Math.floor(Date.now() / 1000);
    const cases = [
      await sign({ key: other.privateKey }),
      await sign({ aud: 'b'.repeat(64) }),
      await sign({ iss: 'https://other-team.cloudflareaccess.com' }),
      await sign({ iss: TEAM }),
      await sign({ iss: `https://${TEAM}/` }),
      await sign({ iat: now - 600, exp: now - 60 }),
      await sign({ nbf: now + 3600 }),
      await sign({ exp: null }),
      await sign({ iat: null }),
    ];
    for (const token of cases) await expectDenied(await request(app, '/api/health', enforced(), { token }));
  });

  it('403 (generic, no config leak) when the key resolver fails, e.g. JWKS network error', async () => {
    const failing = vi.fn((_url: URL): JWTVerifyGetKey => async () => {
      throw new Error(`fetch failed for https://${TEAM}/cdn-cgi/access/certs`);
    });
    const { app } = buildApp(failing);
    const body = await expectDenied(await request(app, '/api/health', enforced(), { token: await sign() }));
    expect(JSON.stringify(body)).not.toContain(TEAM);
  });

  it('does not log tokens or verification errors', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m));
    const { app } = buildApp();
    await request(app, '/api/health', enforced(), { token: await sign({ key: other.privateKey }) });
    await request(app, '/api/health', enforced(), { token: await sign() });
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe('access guard: integration with SIKAP pipeline', () => {
  it('valid token permits /health but /auth/me still requires a SIKAP session', async () => {
    const { app } = buildApp();
    const token = await sign();
    expect((await request(app, '/api/health', enforced(), { token })).status).toBe(200);
    const me = await request(app, '/api/auth/me', enforced(), { token });
    expect(me.status).toBe(401);
  });

  it('no API route bypasses the gate (health, login, unknown routes)', async () => {
    const { app } = buildApp();
    await expectDenied(await request(app, '/api/health', enforced()));
    await expectDenied(await request(app, '/api/auth/me', enforced()));
    await expectDenied(await request(app, '/api/does-not-exist', enforced()));
    await expectDenied(
      await request(app, '/api/auth/login', enforced(), {
        method: 'POST',
        origin: ORIGIN,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nip: '199001012020011001', password: 'x' }),
      }),
    );
  });

  it('a valid Access token does not bypass CSRF on unsafe methods', async () => {
    const { app } = buildApp();
    const token = await sign();
    const body = JSON.stringify({ nip: '199001012020011001', password: 'x' });
    const headers = { 'Content-Type': 'application/json' };
    await expectError(
      await request(app, '/api/auth/login', enforced(), { method: 'POST', token, headers, body }),
      403,
      'CSRF_REJECTED',
    );
    await expectError(
      await request(app, '/api/auth/login', enforced(), {
        method: 'POST',
        token,
        headers,
        body,
        origin: 'https://evil.example',
      }),
      403,
      'CSRF_REJECTED',
    );
  });

  it('invalid token on a mutation neither reads the body nor touches D1', async () => {
    const { app } = buildApp();
    const db = (env as AppEnv['Bindings']).DB;
    const count = async () => {
      const r = await db
        .prepare('SELECT (SELECT COUNT(*) FROM rate_limit) AS rl, (SELECT COUNT(*) FROM sesi) AS s')
        .first<{ rl: number; s: number }>();
      return r;
    };
    const before = await count();
    let pulled = false;
    // highWaterMark 0: the stream is only pulled when someone actually reads the body.
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled = true;
          controller.enqueue(new TextEncoder().encode('{"nip":"199001012020011001","password":"x"}'));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    await expectDenied(
      await request(app, '/api/auth/login', enforced(), {
        method: 'POST',
        origin: ORIGIN,
        token: await sign({ key: other.privateKey }),
        headers: { 'Content-Type': 'application/json' },
        body: stream,
      }),
    );
    expect(pulled).toBe(false);
    expect(await count()).toEqual(before);
  });
});
