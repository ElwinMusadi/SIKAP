// Admin management of integration API keys: /api/admin/kunci-api (shared/integrasi.ts).
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { API_KEY_PATTERN, type KunciApiCreateResponse, type KunciApiListResponse } from '../shared/integrasi';
import { call, createUser, json, login } from './helpers';

const DAY = 86_400_000;
let adminCookie: string;
let adminId: number;

beforeAll(async () => {
  const admin = await createUser({ role: 'Admin' });
  adminId = admin.id;
  adminCookie = await login(admin);
});

function create(body: unknown, cookie = adminCookie) {
  return call('/api/admin/kunci-api', { body, cookie });
}

function ping(kunci: string) {
  return call('/api/v1/ping', { headers: { Authorization: `Bearer ${kunci}` }, origin: null });
}

describe('access control', () => {
  it('requires an Admin session', async () => {
    expect((await call('/api/admin/kunci-api')).status).toBe(401);
    const pegawai = await createUser();
    const cookie = await login(pegawai);
    expect((await call('/api/admin/kunci-api', { cookie })).status).toBe(403);
    expect((await create({ nama: 'X', izin: ['pegawai:baca'] }, cookie)).status).toBe(403);
    expect((await call('/api/admin/kunci-api/1', { method: 'DELETE', cookie })).status).toBe(403);
  });

  it('rejects writes without a same-origin Origin header (CSRF)', async () => {
    const res = await call('/api/admin/kunci-api', { body: { nama: 'X', izin: ['pegawai:baca'] }, cookie: adminCookie, origin: null });
    expect(res.status).toBe(403);
  });
});

describe('create', () => {
  it('returns the key once, stores only its hash, and the key works immediately', async () => {
    const before = Date.now();
    const res = await create({ nama: '  PINTU (produksi)  ', keterangan: 'Portal UPTD', izin: ['pegawai:baca'] });
    expect(res.status).toBe(201);
    const body = await json<KunciApiCreateResponse>(res);
    expect(body.kunci).toMatch(API_KEY_PATTERN);
    expect(body.kunci.startsWith(`skp_${body.item.idPublik}_`)).toBe(true);
    expect(body.item).toMatchObject({
      nama: 'PINTU (produksi)',
      keterangan: 'Portal UPTD',
      izin: ['pegawai:baca'],
      createdBy: { id: adminId },
      lastUsedAt: null,
    });
    // Default validity: 365 days.
    const ttl = Date.parse(body.item.expiresAt) - before;
    expect(ttl).toBeGreaterThan(365 * DAY - 60_000);
    expect(ttl).toBeLessThan(365 * DAY + 60_000);

    const row = await env.DB.prepare(`SELECT token_hash FROM kunci_api WHERE id = ?1`).bind(body.item.id).first<{ token_hash: string }>();
    expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.token_hash).not.toContain(body.kunci);

    const list = await call('/api/admin/kunci-api', { cookie: adminCookie });
    const listText = await list.text();
    expect(listText).not.toContain(body.kunci);
    expect(listText).not.toContain(row!.token_hash);
    expect(listText).not.toMatch(/token_?hash|"kunci"/i);
    const items = (JSON.parse(listText) as KunciApiListResponse).items;
    expect(items.find((i) => i.id === body.item.id)).toEqual(body.item);

    expect((await ping(body.kunci)).status).toBe(200);
  });

  it('logs APIKEY_CREATE with the public id but never the key', async () => {
    const body = await json<KunciApiCreateResponse>(await create({ nama: 'Klien Log', izin: ['pegawai:baca'], masaBerlakuHari: 90 }));
    const ttl = Date.parse(body.item.expiresAt) - Date.parse(body.item.createdAt);
    expect(ttl).toBe(90 * DAY);
    const log = await env.DB.prepare(
      `SELECT actor_id, action, target_type, target_id, description FROM log_aktivitas
        WHERE action = 'APIKEY_CREATE' AND target_id = ?1`,
    )
      .bind(String(body.item.id))
      .first<Record<string, unknown>>();
    expect(log).toMatchObject({ actor_id: adminId, target_type: 'kunci_api' });
    expect(log?.description).toContain(`skp_${body.item.idPublik}`);
    expect(log?.description).not.toContain(body.kunci);

    const filtered = await json<{ items: { action: string }[] }>(await call('/api/admin/log?category=integrasi', { cookie: adminCookie }));
    expect(filtered.items.length).toBeGreaterThan(0);
    expect(filtered.items.every((i) => i.action.startsWith('API'))).toBe(true);
  });

  it('validates input', async () => {
    const cases: [string, unknown, string][] = [
      ['empty name', { nama: '  ', izin: ['pegawai:baca'] }, 'nama'],
      ['long name', { nama: 'x'.repeat(61), izin: ['pegawai:baca'] }, 'nama'],
      ['no scope', { nama: 'X', izin: [] }, 'izin'],
      ['unknown scope', { nama: 'X', izin: ['pegawai:tulis'] }, 'izin.0'],
      ['bad validity', { nama: 'X', izin: ['pegawai:baca'], masaBerlakuHari: 30 }, 'masaBerlakuHari'],
      ['no expiry allowed', { nama: 'X', izin: ['pegawai:baca'], masaBerlakuHari: null }, 'masaBerlakuHari'],
      ['unknown field', { nama: 'X', izin: ['pegawai:baca'], kunci: 'skp_x' }, '_form'],
    ];
    for (const [name, body, field] of cases) {
      const res = await create(body);
      expect(res.status, name).toBe(400);
      const err = await json<{ error: { code: string; fields?: Record<string, string> } }>(res);
      expect(err.error.code, name).toBe('VALIDATION_ERROR');
      expect(Object.keys(err.error.fields ?? {}), name).toContain(field);
    }
  });
});

describe('delete', () => {
  it('revokes immediately, logs APIKEY_DELETE, and is idempotent-safe (404 afterwards)', async () => {
    const body = await json<KunciApiCreateResponse>(await create({ nama: 'Klien Hapus', izin: ['pegawai:baca'] }));
    expect((await ping(body.kunci)).status).toBe(200);

    const del = await call(`/api/admin/kunci-api/${body.item.id}`, { method: 'DELETE', cookie: adminCookie });
    expect(del.status).toBe(204);
    expect((await ping(body.kunci)).status).toBe(401);
    expect(await env.DB.prepare(`SELECT 1 FROM kunci_api WHERE id = ?1`).bind(body.item.id).first()).toBeNull();

    const log = await env.DB.prepare(`SELECT actor_id, description FROM log_aktivitas WHERE action = 'APIKEY_DELETE' AND target_id = ?1`)
      .bind(String(body.item.id))
      .first<{ actor_id: number; description: string }>();
    expect(log?.actor_id).toBe(adminId);
    expect(log?.description).toContain('Klien Hapus');

    expect((await call(`/api/admin/kunci-api/${body.item.id}`, { method: 'DELETE', cookie: adminCookie })).status).toBe(404);
    expect((await call('/api/admin/kunci-api/abc', { method: 'DELETE', cookie: adminCookie })).status).toBe(404);
  });
});
