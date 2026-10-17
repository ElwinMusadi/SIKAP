import { env } from 'cloudflare:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK, type JWTVerifyGetKey } from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ApiErrorBody } from '../shared/api';
import type { Bindings } from '../server/env';
import { ACCESS_JWT_HEADER, ACCESS_MESSAGES } from '../server/middleware/access';
import { createUatHandler, isApiPath, type UatBindings } from '../server/uat-entry';
import uatDefault from '../server/uat-deployment';

const ORIGIN = 'https://uat.example.invalid';
const TEAM = 'sikap-uat.cloudflareaccess.com';
const AUD = 'a'.repeat(32) + '0123456789abcdef0123456789abcdef';
const KID = 'uat-test-key';

let privateKey: CryptoKey;
let localJwks: JWTVerifyGetKey;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: KID, alg: 'RS256', use: 'sig' };
  localJwks = createLocalJWKSet({ keys: [jwk] });
});

afterEach(() => vi.restoreAllMocks());

function assetsStub() {
  const fetch = vi.fn(async (_req: Request) => new Response('<!doctype html>ok', { status: 200 }));
  return { assets: { fetch, connect: vi.fn() } as unknown as Fetcher, fetch };
}

function bindings(overrides: Partial<UatBindings>): UatBindings {
  return { ...(env as Bindings), ...overrides };
}

const enforced = (extra: Partial<UatBindings> = {}) =>
  bindings({ ACCESS_REQUIRED: '1', ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUDIENCE: AUD, ...extra });

async function sign(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ type: 'app' })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(`https://${TEAM}`)
    .setAudience(AUD)
    .setSubject('synthetic-subject')
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(privateKey);
}

function req(path: string, init: { method?: string; headers?: Record<string, string> } = {}) {
  return new Request(`${ORIGIN}${path}`, { method: init.method ?? 'GET', headers: init.headers });
}

async function expectError(res: Response, status: number, message: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get('cache-control')).toBe('no-store');
  const body = (await res.json()) as ApiErrorBody;
  expect(body.error.message).toBe(message);
}

const testHandler = () => createUatHandler({ createResolver: vi.fn((_url: URL) => localJwks) });

describe('UAT entry: routing', () => {
  it('only /api and /api/* are API paths', () => {
    expect(isApiPath('/api')).toBe(true);
    expect(isApiPath('/api/health')).toBe(true);
    for (const p of ['/', '/apiX', '/api-x', '/API/health', '/index.html', '/assets/a.js']) {
      expect(isApiPath(p)).toBe(false);
    }
  });
});

describe('UAT entry: fail closed', () => {
  it.each([undefined, '0', '', 'true', ' 1'])('mode %j returns fixed 503 no-store on every path', async (mode) => {
    const { assets, fetch } = assetsStub();
    const handler = testHandler();
    for (const path of ['/', '/index.html', '/api/health', '/api', '/apiX']) {
      const res = await handler.fetch(req(path), enforced({ ACCESS_REQUIRED: mode, ASSETS: assets }));
      await expectError(res, 503, ACCESS_MESSAGES.config);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('mode 1 with invalid Access config returns 503 for static and API', async () => {
    const { assets, fetch } = assetsStub();
    const handler = testHandler();
    const b = bindings({ ACCESS_REQUIRED: '1', ACCESS_AUDIENCE: AUD, ASSETS: assets });
    await expectError(await handler.fetch(req('/'), b), 503, ACCESS_MESSAGES.config);
    await expectError(await handler.fetch(req('/api/health'), b), 503, ACCESS_MESSAGES.config);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('static paths (any method, incl. /apiX) are denied without a signed token; cookie/email headers are ignored', async () => {
    const { assets, fetch } = assetsStub();
    const handler = testHandler();
    const token = await sign();
    const cases: [string, string, Record<string, string>][] = [
      ['GET', '/', {}],
      ['HEAD', '/index.html', {}],
      ['POST', '/apiX', {}],
      ['GET', '/dashboard', { Cookie: `CF_Authorization=${token}` }],
      ['GET', '/', { 'Cf-Access-Authenticated-User-Email': 'tester@example.invalid' }],
      ['GET', '/', { [ACCESS_JWT_HEADER]: 'not-a-jwt' }],
    ];
    for (const [method, path, headers] of cases) {
      const res = await handler.fetch(req(path, { method, headers }), enforced({ ASSETS: assets }));
      expect(res.status).toBe(403);
      expect(res.headers.get('cache-control')).toBe('no-store');
      if (method !== 'HEAD') expect(((await res.json()) as ApiErrorBody).error.message).toBe(ACCESS_MESSAGES.denied);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('valid token but missing ASSETS binding returns 503 no-store', async () => {
    const res = await testHandler().fetch(req('/', { headers: { [ACCESS_JWT_HEADER]: await sign() } }), enforced());
    await expectError(res, 503, ACCESS_MESSAGES.config);
  });
});

describe('UAT entry: API delegation', () => {
  it('/api and /api/* reach the existing app gate (403, no-store) without network or ASSETS', async () => {
    const netFetch = vi.spyOn(globalThis, 'fetch');
    const { assets, fetch } = assetsStub();
    for (const path of ['/api', '/api/', '/api/health', '/api/auth/me']) {
      const res = await uatDefault.fetch(req(path, { headers: { [ACCESS_JWT_HEADER]: 'bad' } }), enforced({ ASSETS: assets }));
      await expectError(res, 403, ACCESS_MESSAGES.denied);
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(netFetch).not.toHaveBeenCalled();
  });
});

describe('UAT entry: static allowed', () => {
  it('valid signed token serves ASSETS with the original request', async () => {
    const { assets, fetch } = assetsStub();
    const res = await testHandler().fetch(
      req('/index.html', { headers: { [ACCESS_JWT_HEADER]: await sign() } }),
      enforced({ ASSETS: assets }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<!doctype html>ok');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(new URL(fetch.mock.calls[0]![0].url).pathname).toBe('/index.html');
  });
});
