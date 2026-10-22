// /api/v1 integration API (docs/RENCANA-API-INTEGRASI.md, contract: shared/integrasi.ts).
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { API_AUTH_FAIL_LIMIT, API_RATE_LIMIT, V1_PEGAWAI_DETAIL_KEYS, V1_PEGAWAI_ITEM_KEYS } from '../shared/integrasi';
import { generateApiKey, hashApiKey } from '../server/lib/crypto';
import { call, json, login, createUser, uniqueIp, uniqueNip } from './helpers';

const DAY = 86_400_000;
let tagSeq = 0;
/** Unique, LIKE-safe name marker: the D1 database is shared by every test in this file. */
const tag = () => `Integ${Date.now().toString(36)}${(tagSeq += 1)}`;

interface IssuedKey {
  id: number;
  kunci: string;
  idPublik: string;
}

async function issueKey(opts: { izin?: unknown[]; expired?: boolean; nama?: string } = {}): Promise<IssuedKey> {
  const { kunci, idPublik } = generateApiKey();
  const now = Date.now();
  const createdAt = new Date(opts.expired ? now - 2 * DAY : now - 1000).toISOString();
  const expiresAt = new Date(opts.expired ? now - DAY : now + 365 * DAY).toISOString();
  const row = await env.DB.prepare(
    `INSERT INTO kunci_api (id_publik, token_hash, nama, izin, created_at, created_by, created_by_nama, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 1, 'Admin Uji', ?6) RETURNING id`,
  )
    .bind(idPublik, await hashApiKey(kunci), opts.nama ?? `Klien ${idPublik}`, JSON.stringify(opts.izin ?? ['pegawai:baca']), createdAt, expiresAt)
    .first<{ id: number }>();
  if (!row) throw new Error('insert kunci failed');
  return { id: row.id, kunci, idPublik };
}

interface Fixture {
  id: number;
  nip: string;
  nama: string;
}

/** Personal data stored on every fixture that must never appear in any v1 response. */
const SECRET_VALUES = { alamat: 'Jl. Rahasia Integrasi 9', tanggalLahir: '1988-08-08' };

async function pegawai(
  nama: string,
  opts: {
    statusAkun?: 'Aktif' | 'Nonaktif';
    deleted?: boolean;
    status?: 'PNS' | 'CPNS' | 'PPPK' | null;
    pangkat?: string | null;
    unitId?: number | null;
    email?: string | null;
    noHp?: string | null;
  } = {},
): Promise<Fixture> {
  const nip = uniqueNip();
  const now = new Date().toISOString();
  const deleted = opts.deleted ? now : null;
  const row = await env.DB.prepare(
    `INSERT INTO pegawai (nip, nik, nama, status_akun, status_kepegawaian, pangkat_kode, jabatan, jenis_jabatan, unit_id,
                          email, no_hp, alamat, tanggal_lahir, agama, deleted_at, purge_after)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'Pengelola Kepegawaian', 'Pelaksana', ?7, ?8, ?9, ?10, ?11, 'Islam', ?12, ?13) RETURNING id`,
  )
    .bind(
      nip,
      `53${nip.slice(-14)}`,
      nama,
      opts.statusAkun ?? 'Aktif',
      opts.status === undefined ? 'PNS' : opts.status,
      opts.pangkat === undefined ? 'III/a' : opts.pangkat,
      opts.unitId === undefined ? 1 : opts.unitId,
      opts.email === undefined ? `${nip}@example.test` : opts.email,
      opts.noHp === undefined ? `62812${nip.slice(-8)}` : opts.noHp,
      SECRET_VALUES.alamat,
      SECRET_VALUES.tanggalLahir,
      deleted,
      deleted ? new Date(Date.now() + 7 * DAY).toISOString() : null,
    )
    .first<{ id: number }>();
  if (!row) throw new Error('insert pegawai failed');
  return { id: row.id, nip, nama };
}

function v1(path: string, kunci?: string | null, opts: { ip?: string; headers?: Record<string, string>; method?: string } = {}) {
  const headers: Record<string, string> = { ...opts.headers };
  if (kunci) headers['Authorization'] = `Bearer ${kunci}`;
  // Server-to-server callers send no Origin header.
  return call(`/api/v1${path}`, { headers, ip: opts.ip, method: opts.method, origin: null });
}

async function errorCode(res: Response): Promise<string> {
  return (await json<{ error: { code: string } }>(res)).error.code;
}

let key: IssuedKey;
let pangkatNama: string;
let unitNama: string;

beforeAll(async () => {
  key = await issueKey({ nama: 'PINTU Uji' });
  pangkatNama = (await env.DB.prepare(`SELECT nama FROM ref_pangkat_golongan WHERE kode = 'III/a'`).first<{ nama: string }>())!.nama;
  unitNama = (await env.DB.prepare(`SELECT nama FROM ref_unit_organisasi WHERE id = 1`).first<{ nama: string }>())!.nama;
});

describe('authentication', () => {
  it('rejects missing, malformed, unknown, tampered, expired and deleted keys with one generic 401', async () => {
    const expired = await issueKey({ expired: true });
    const deleted = await issueKey();
    await env.DB.prepare(`DELETE FROM kunci_api WHERE id = ?1`).bind(deleted.id).run();
    const unknown = generateApiKey().kunci;
    const tampered = `${key.kunci.slice(0, -1)}${key.kunci.endsWith('A') ? 'B' : 'A'}`;
    const cases: [string, Record<string, string>][] = [
      ['missing', {}],
      ['basic scheme', { Authorization: `Basic ${btoa('a:b')}` }],
      ['malformed', { Authorization: 'Bearer skp_bad' }],
      ['unknown', { Authorization: `Bearer ${unknown}` }],
      ['tampered secret', { Authorization: `Bearer ${tampered}` }],
      ['expired', { Authorization: `Bearer ${expired.kunci}` }],
      ['deleted', { Authorization: `Bearer ${deleted.kunci}` }],
    ];
    for (const [name, headers] of cases) {
      const res = await v1('/ping', null, { headers });
      expect(res.status, name).toBe(401);
      expect(await errorCode(res), name).toBe('API_KEY_INVALID');
      expect(res.headers.get('WWW-Authenticate'), name).toMatch(/^Bearer/);
      expect(res.headers.get('Cache-Control'), name).toBe('no-store');
    }
  });

  it('never reads a key from the query string', async () => {
    const res = await v1(`/ping?api_key=${encodeURIComponent(key.kunci)}&key=${encodeURIComponent(key.kunci)}`);
    expect(res.status).toBe(401);
  });

  it('does not accept an SPA session cookie instead of a key', async () => {
    const admin = await createUser({ role: 'Admin' });
    const cookie = await login(admin);
    const res = await call('/api/v1/ping', { cookie });
    expect(res.status).toBe(401);
  });

  it('answers ping with the client name, public key id, scopes and expiry', async () => {
    const res = await v1('/ping', key.kunci);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toEqual({
      klien: 'PINTU Uji',
      idKunci: `skp_${key.idPublik}`,
      izin: ['pegawai:baca'],
      kedaluwarsa: expect.any(String),
    });
    expect(JSON.stringify(body)).not.toContain(key.kunci);
  });

  it('stamps last use (time and IP) on the key', async () => {
    const fresh = await issueKey();
    const ip = uniqueIp();
    expect((await v1('/ping', fresh.kunci, { ip })).status).toBe(200);
    const row = await env.DB.prepare(`SELECT last_used_at, last_used_ip FROM kunci_api WHERE id = ?1`).bind(fresh.id).first<{
      last_used_at: string | null;
      last_used_ip: string | null;
    }>();
    expect(row?.last_used_at).toBeTruthy();
    expect(row?.last_used_ip).toBe(ip);
  });

  it('enforces scopes: a key without pegawai:baca gets 403 on employee data', async () => {
    for (const izin of [[], ['pegawai:tulis']]) {
      const limited = await issueKey({ izin });
      expect((await v1('/ping', limited.kunci)).status).toBe(200);
      const res = await v1('/pegawai?q=ab', limited.kunci);
      expect(res.status).toBe(403);
      expect(await errorCode(res)).toBe('API_SCOPE_DENIED');
      expect((await v1('/pegawai/199001012020011001', limited.kunci)).status).toBe(403);
    }
  });

  it('is read-only: unsafe methods without Origin are rejected, unknown paths 404', async () => {
    const post = await v1('/pegawai', key.kunci, { method: 'POST' });
    expect(post.status).toBe(403);
    expect(await errorCode(post)).toBe('CSRF_REJECTED');
    expect((await v1('/tidak-ada', key.kunci)).status).toBe(404);
  });
});

describe('rate limits', () => {
  it(`allows ${API_RATE_LIMIT.requests} requests per minute per key, then 429 with Retry-After, logged once`, async () => {
    const busy = await issueKey({ nama: 'Klien Sibuk' });
    await env.DB.prepare(`INSERT INTO rate_limit (key, window_start, count) VALUES (?1, ?2, ?3)`)
      .bind(`api:${busy.id}`, new Date().toISOString(), API_RATE_LIMIT.requests)
      .run();
    for (let i = 0; i < 2; i++) {
      const res = await v1('/ping', busy.kunci);
      expect(res.status).toBe(429);
      expect(await errorCode(res)).toBe('RATE_LIMITED');
      const retry = Number(res.headers.get('Retry-After'));
      expect(retry).toBeGreaterThanOrEqual(1);
      expect(retry).toBeLessThanOrEqual(API_RATE_LIMIT.windowSeconds);
    }
    const logs = await env.DB.prepare(`SELECT COUNT(*) AS n FROM log_aktivitas WHERE action = 'API_RATE_LIMITED' AND target_id = ?1`)
      .bind(String(busy.id))
      .first<{ n: number }>();
    expect(logs?.n).toBe(1);
  });

  it('logs only the first failed authentication per IP window and throttles after the limit', async () => {
    const ip = uniqueIp();
    const bad = generateApiKey().kunci;
    expect((await v1('/ping', bad, { ip })).status).toBe(401);
    expect((await v1('/ping', bad, { ip })).status).toBe(401);
    const failed = await env.DB.prepare(`SELECT COUNT(*) AS n, MAX(description) AS d FROM log_aktivitas WHERE action = 'API_AUTH_FAILED' AND ip = ?1`)
      .bind(ip)
      .first<{ n: number; d: string }>();
    expect(failed?.n).toBe(1);
    expect(failed?.d).not.toContain(bad); // only the public id may appear, never the secret

    await env.DB.prepare(`UPDATE rate_limit SET count = ?2 WHERE key = ?1`).bind(`api-auth-ip:${ip}`, API_AUTH_FAIL_LIMIT.attempts).run();
    const throttled = await v1('/ping', bad, { ip });
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get('Retry-After')).toBeTruthy();
    const limited = await env.DB.prepare(`SELECT COUNT(*) AS n FROM log_aktivitas WHERE action = 'API_RATE_LIMITED' AND ip = ?1`)
      .bind(ip)
      .first<{ n: number }>();
    expect(limited?.n).toBe(1);
  });
});

describe('GET /api/v1/pegawai', () => {
  let t: string;
  let a: Fixture;
  let b: Fixture;

  beforeAll(async () => {
    t = tag();
    // Inserted out of order: the API sorts by nama.
    b = await pegawai(`${t} Beta`, { status: 'PPPK', pangkat: null, unitId: null, email: null, noHp: null });
    a = await pegawai(`${t} Alfa`);
    await pegawai(`${t} Nonaktif`, { statusAkun: 'Nonaktif' });
    await pegawai(`${t} Terhapus`, { deleted: true });
  });

  it('returns only active employees, sorted by nama, with exactly the whitelisted fields', async () => {
    const res = await v1(`/pegawai?q=${t}`, key.kunci);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = await json<{ items: Record<string, unknown>[]; page: number; pageSize: number; total: number }>(res);
    expect(body).toMatchObject({ page: 1, pageSize: 20, total: 2 });
    expect(body.items.map((i) => i.nama)).toEqual([a.nama, b.nama]);
    for (const item of body.items) expect(Object.keys(item).sort()).toEqual([...V1_PEGAWAI_ITEM_KEYS].sort());
    expect(body.items[0]).toEqual({
      nip: a.nip,
      nama: a.nama,
      statusKepegawaian: 'PNS',
      pangkat: { kode: 'III/a', nama: pangkatNama },
      jabatan: 'Pengelola Kepegawaian',
      jenisJabatan: 'Pelaksana',
      unit: { id: 1, nama: unitNama },
      diperbarui: expect.any(String),
    });
    expect(body.items[1]).toMatchObject({ nip: b.nip, statusKepegawaian: 'PPPK', pangkat: null, unit: null });
  });

  it('never leaks contact or personal data in search results', async () => {
    const text = await (await v1(`/pegawai?q=${t}`, key.kunci)).text();
    for (const leak of [`${a.nip}@example.test`, `62812${a.nip.slice(-8)}`, SECRET_VALUES.alamat, SECRET_VALUES.tanggalLahir, `53${a.nip.slice(-14)}`, 'Islam']) {
      expect(text).not.toContain(leak);
    }
    for (const field of ['email', 'noHp', 'nik', 'alamat', 'no_hp', 'password', 'role']) expect(text).not.toContain(`"${field}"`);
  });

  it('searches by NIP and treats % and _ literally', async () => {
    const byNip = await json<{ items: { nip: string }[]; total: number }>(await v1(`/pegawai?q=${a.nip}`, key.kunci));
    expect(byNip.total).toBe(1);
    expect(byNip.items[0]?.nip).toBe(a.nip);
    const literal = await json<{ total: number }>(await v1(`/pegawai?q=${encodeURIComponent(`${t}%`)}`, key.kunci));
    expect(literal.total).toBe(0);
  });

  it('filters by status kepegawaian and unit', async () => {
    const pppk = await json<{ items: { nip: string }[] }>(await v1(`/pegawai?q=${t}&statusKepegawaian=PPPK`, key.kunci));
    expect(pppk.items.map((i) => i.nip)).toEqual([b.nip]);
    const unit = await json<{ items: { nip: string }[] }>(await v1(`/pegawai?q=${t}&unitId=1`, key.kunci));
    expect(unit.items.map((i) => i.nip)).toEqual([a.nip]);
  });

  it('paginates with pageSize 10/20/50', async () => {
    const p = tag();
    for (let i = 0; i < 11; i++) await pegawai(`${p} ${String(i).padStart(2, '0')}`);
    const page2 = await json<{ items: { nama: string }[]; total: number; page: number }>(await v1(`/pegawai?q=${p}&pageSize=10&page=2`, key.kunci));
    expect(page2).toMatchObject({ total: 11, page: 2 });
    expect(page2.items.map((i) => i.nama)).toEqual([`${p} 10`]);
  });

  it('validates the query', async () => {
    for (const qs of ['q=a', 'pageSize=15', 'statusKepegawaian=Honorer', 'page=0', 'unitId=x']) {
      const res = await v1(`/pegawai?${qs}`, key.kunci);
      expect(res.status, qs).toBe(400);
      expect(await errorCode(res), qs).toBe('VALIDATION_ERROR');
    }
    expect((await v1('/pegawai?q=', key.kunci)).status).toBe(200);
  });
});

describe('GET /api/v1/pegawai/{nip}', () => {
  it('returns the search fields plus email and no HP, and logs the read', async () => {
    const t = tag();
    const p = await pegawai(`${t} Detail`);
    const ip = uniqueIp();
    const res = await v1(`/pegawai/${p.nip}`, key.kunci, { ip });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(Object.keys(body).sort()).toEqual([...V1_PEGAWAI_DETAIL_KEYS].sort());
    expect(body).toMatchObject({ nip: p.nip, nama: p.nama, email: `${p.nip}@example.test`, noHp: `62812${p.nip.slice(-8)}` });
    const text = JSON.stringify(body);
    for (const leak of [SECRET_VALUES.alamat, SECRET_VALUES.tanggalLahir, `53${p.nip.slice(-14)}`]) expect(text).not.toContain(leak);

    const log = await env.DB.prepare(
      `SELECT actor_id, actor_nama, actor_role, target_type, target_id, description, result, ip
         FROM log_aktivitas WHERE action = 'API_PEGAWAI_READ' AND target_id = ?1 ORDER BY id DESC`,
    )
      .bind(String(p.id))
      .first<Record<string, unknown>>();
    expect(log).toMatchObject({ actor_id: null, actor_nama: 'PINTU Uji', actor_role: 'API', target_type: 'pegawai', result: 'SUCCESS', ip });
    expect(log?.description).toContain(`skp_${key.idPublik}`);
    expect(log?.description).not.toContain(key.kunci);
  });

  it('returns null contact fields when SIKAP has none', async () => {
    const p = await pegawai(`${tag()} Tanpa Kontak`, { email: null, noHp: null });
    expect(await json(await v1(`/pegawai/${p.nip}`, key.kunci))).toMatchObject({ email: null, noHp: null });
  });

  it('404 for inactive, deleted or unknown employees; 400 for a malformed NIP', async () => {
    const t = tag();
    const inactive = await pegawai(`${t} Nonaktif`, { statusAkun: 'Nonaktif' });
    const deleted = await pegawai(`${t} Terhapus`, { deleted: true });
    for (const nip of [inactive.nip, deleted.nip, uniqueNip()]) {
      const res = await v1(`/pegawai/${nip}`, key.kunci);
      expect(res.status).toBe(404);
      expect(await errorCode(res)).toBe('NOT_FOUND');
    }
    const reads = await env.DB.prepare(`SELECT COUNT(*) AS n FROM log_aktivitas WHERE action = 'API_PEGAWAI_READ' AND target_id IN (?1, ?2)`)
      .bind(String(inactive.id), String(deleted.id))
      .first<{ n: number }>();
    expect(reads?.n).toBe(0);
    const bad = await v1('/pegawai/12345', key.kunci);
    expect(bad.status).toBe(400);
    expect(await errorCode(bad)).toBe('VALIDATION_ERROR');
  });
});
