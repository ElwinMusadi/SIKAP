import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type {
  AdminJenisDokumen,
  AdminJenisResponse,
  AdminRefResponse,
  LogResponse,
} from '../shared/administrasi';
import type { ApiErrorBody } from '../shared/api';
import type { DokumenListResponse } from '../shared/dokumen';
import type { DashboardResponse, RefResponse } from '../shared/profile';
import {
  deleteWajibIfStamp,
  insertWajibIfStamp,
  updateJenisIfStamp,
} from '../server/db/administrasi';
import type { AuthContext } from '../server/env';
import { auditStatement } from '../server/lib/audit';
import { encodeLogCursor, updateJenis } from '../server/services/administrasi';
import { call, createUser, json, login, uniqueNip } from './helpers';
import { insertArsip, person } from './phase5-helpers';

let admin: string;
let adminId: number;
let pegawai: string;

beforeAll(async () => {
  const a = await createUser({ role: 'Admin' });
  adminId = a.id;
  admin = await login(a);
  pegawai = await login(await createUser());
});

const rnd = () => Math.random().toString(36).slice(2, 8).toUpperCase();

async function errorOf(res: Response): Promise<ApiErrorBody['error']> {
  return (await json<ApiErrorBody>(res)).error;
}

async function insertLog(rows: { ts: string; action: string; description: string; result?: string }[]): Promise<void> {
  await env.DB.batch(
    rows.map((r) =>
      env.DB.prepare(
        `INSERT INTO log_aktivitas (ts, actor_id, actor_nip, actor_nama, actor_role, action, target_type, target_id, description, result, ip)
         VALUES (?1, 7, '199001012020011001', 'Aktor Uji', 'Admin', ?2, 'x', '1', ?3, ?4, '203.0.113.9')`,
      ).bind(r.ts, r.action, r.description, r.result ?? 'SUCCESS'),
    ),
  );
}

async function getLog(params: Record<string, string>): Promise<Response> {
  return call(`/api/admin/log?${new URLSearchParams(params)}`, { cookie: admin });
}

async function countAudit(action: string, targetId: string): Promise<number> {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM log_aktivitas WHERE action = ?1 AND target_id = ?2`)
    .bind(action, targetId)
    .first<{ n: number }>();
  return r!.n;
}

// ---------------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------------

describe('admin administrasi access', () => {
  it('requires a session, the Admin role and a same-origin Origin for writes', async () => {
    expect((await call('/api/admin/log')).status).toBe(401);
    for (const p of ['/api/admin/log', '/api/admin/ref', '/api/admin/jenis-dokumen']) {
      const res = await call(p, { cookie: pegawai });
      expect(res.status).toBe(403);
      expect((await errorOf(res)).code).toBe('FORBIDDEN');
    }
    const forbidden = await call('/api/admin/ref/unit', { cookie: pegawai, body: { nama: `Unit ${rnd()}` } });
    expect(forbidden.status).toBe(403);
    const noOrigin = await call('/api/admin/ref/unit', { cookie: admin, body: { nama: `Unit ${rnd()}` }, origin: null });
    expect((await errorOf(noOrigin)).code).toBe('CSRF_REJECTED');
    const evil = await call('/api/admin/jenis-dokumen', { cookie: admin, body: {}, origin: 'https://evil.test' });
    expect((await errorOf(evil)).code).toBe('CSRF_REJECTED');
  });
});

// ---------------------------------------------------------------------------
// Activity log
// ---------------------------------------------------------------------------

describe('GET /api/admin/log', () => {
  it('pages 25 rows by ts DESC, id DESC with stable cursors over equal timestamps', async () => {
    const tok = `pg${rnd()}`;
    const ts = '2026-05-01T01:02:03.004Z';
    await insertLog(Array.from({ length: 30 }, (_, i) => ({ ts, action: 'CONFIG_UPDATE', description: `${tok} #${i}` })));
    await insertLog([{ ts: '2026-05-01T01:02:03.005Z', action: 'CONFIG_UPDATE', description: `${tok} newest` }]);

    const p1 = await json<LogResponse>(await getLog({ q: tok }));
    expect(p1.items).toHaveLength(25);
    expect(p1.items[0]!.description).toBe(`${tok} newest`);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await json<LogResponse>(await getLog({ q: tok, cursor: p1.nextCursor! }));
    expect(p2.items).toHaveLength(6);
    expect(p2.nextCursor).toBeNull();

    const all = [...p1.items, ...p2.items];
    expect(new Set(all.map((i) => i.id)).size).toBe(31);
    for (let i = 1; i < all.length; i++) {
      const a = all[i - 1]!;
      const b = all[i]!;
      expect(a.ts > b.ts || (a.ts === b.ts && a.id > b.id)).toBe(true);
    }
    const item = all[1]!;
    expect(item.actor).toEqual({ id: 7, nip: '199001012020011001', nama: 'Aktor Uji', role: 'Admin' });
    expect(item).not.toHaveProperty('ip');
    expect(JSON.stringify(all)).not.toContain('203.0.113.9');
  });

  it('filters by whitelisted category prefixes and result', async () => {
    const tok = `cat${rnd()}`;
    const ts = '2026-05-02T00:00:00.000Z';
    const actions = [
      'LOGIN', 'LOGOUT', 'PASSWORD_RESET', 'SESSION_REVOKE', 'ACCOUNT_UNLOCK',
      'PEGAWAI_CREATE', 'PROFILE_UPDATE', 'FOTO_PROFIL_UPLOAD',
      'DOKUMEN_UPLOAD', 'PENGAJUAN_CREATE',
      'CONFIG_UPDATE', 'WA_TEST', 'BACKUP_RUN', 'REF_CREATE', 'JENIS_DOKUMEN_UPDATE',
      'XLOGIN',
    ];
    await insertLog(actions.map((action) => ({ ts, action, description: tok, result: action === 'LOGIN' ? 'FAILURE' : 'SUCCESS' })));
    const actionsOf = async (params: Record<string, string>) =>
      (await json<LogResponse>(await getLog({ q: tok, ...params }))).items.map((i) => i.action).sort();

    expect(await actionsOf({ category: 'auth' })).toEqual(['ACCOUNT_UNLOCK', 'LOGIN', 'LOGOUT', 'PASSWORD_RESET', 'SESSION_REVOKE']);
    expect(await actionsOf({ category: 'pegawai' })).toEqual(['FOTO_PROFIL_UPLOAD', 'PEGAWAI_CREATE', 'PROFILE_UPDATE']);
    expect(await actionsOf({ category: 'dokumen' })).toEqual(['DOKUMEN_UPLOAD']);
    expect(await actionsOf({ category: 'pengajuan' })).toEqual(['PENGAJUAN_CREATE']);
    expect(await actionsOf({ category: 'sistem' })).toEqual(['BACKUP_RUN', 'CONFIG_UPDATE', 'JENIS_DOKUMEN_UPDATE', 'REF_CREATE', 'WA_TEST']);
    expect(await actionsOf({ category: 'auth', result: 'FAILURE' })).toEqual(['LOGIN']);
    expect(await actionsOf({})).toHaveLength(actions.length);
    expect((await getLog({ category: 'auth; DROP TABLE x' })).status).toBe(400);
    expect((await getLog({ result: 'OK' })).status).toBe(400);
  });

  it('searches q as a literal substring (LIKE wildcards escaped)', async () => {
    const tok = `lk${rnd()}`;
    const ts = '2026-05-03T00:00:00.000Z';
    await insertLog([
      { ts, action: 'CONFIG_UPDATE', description: `${tok} 100%_done` },
      { ts, action: 'CONFIG_UPDATE', description: `${tok} 100xydone` },
      { ts, action: 'CONFIG_UPDATE', description: `${tok} back\\slash` },
    ]);
    const descs = async (q: string) => (await json<LogResponse>(await getLog({ q }))).items.map((i) => i.description);
    expect(await descs(`${tok} 100%_`)).toEqual([`${tok} 100%_done`]);
    expect(await descs(`${tok} back\\`)).toEqual([`${tok} back\\slash`]);
    expect(await descs(`${tok} 100`)).toHaveLength(2);
    // actor nama / nip are searchable too.
    expect((await json<LogResponse>(await getLog({ q: 'Aktor Uji' }))).items.length).toBeGreaterThan(0);
    expect((await getLog({ q: 'x'.repeat(101) })).status).toBe(400);
  });

  it('applies WITA (UTC+8) day boundaries: from inclusive, to through end of day', async () => {
    const tok = `dt${rnd()}`;
    await insertLog([
      { ts: '2026-03-09T15:59:59.999Z', action: 'CONFIG_UPDATE', description: `${tok} a` }, // 09 Mar 23:59 WITA
      { ts: '2026-03-09T16:00:00.000Z', action: 'CONFIG_UPDATE', description: `${tok} b` }, // 10 Mar 00:00 WITA
      { ts: '2026-03-10T15:59:59.999Z', action: 'CONFIG_UPDATE', description: `${tok} c` }, // 10 Mar 23:59 WITA
      { ts: '2026-03-10T16:00:00.000Z', action: 'CONFIG_UPDATE', description: `${tok} d` }, // 11 Mar 00:00 WITA
    ]);
    const descs = async (params: Record<string, string>) =>
      (await json<LogResponse>(await getLog({ q: tok, ...params }))).items.map((i) => i.description);
    expect(await descs({ from: '2026-03-10', to: '2026-03-10' })).toEqual([`${tok} c`, `${tok} b`]);
    expect(await descs({ from: '2026-03-10' })).toEqual([`${tok} d`, `${tok} c`, `${tok} b`]);
    expect(await descs({ to: '2026-03-09' })).toEqual([`${tok} a`]);
  });

  it('rejects malformed cursors and date ranges with 400', async () => {
    const b64 = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const bad = [
      'abc!',
      b64('x|1'),
      b64('2026-05-01T00:00:00.000Z|0'),
      b64('2026-05-01T00:00:00.000Z|-1'),
      b64('2026-05-01T00:00:00.000Z|01'),
      b64('2026-05-01T00:00:00.000Z|1.5'),
      b64('2026-05-01T00:00:00Z|1'),
      b64('2026-02-30T00:00:00.000Z|1'),
      b64('2026-05-01T00:00:00.000Z|99999999999999999'),
      `${encodeLogCursor('2026-05-01T00:00:00.000Z', 5)}=`,
      'A'.repeat(201),
    ];
    for (const cursor of bad) {
      const res = await getLog({ cursor });
      expect(res.status, cursor).toBe(400);
      expect((await errorOf(res)).code).toBe('VALIDATION_ERROR');
    }
    expect((await getLog({ cursor: encodeLogCursor('2026-05-01T00:00:00.000Z', 5) })).status).toBe(200);
    expect((await getLog({ from: '2026-03-11', to: '2026-03-10' })).status).toBe(400);
    expect((await getLog({ from: '2026-02-30' })).status).toBe(400);
    expect((await getLog({ to: '10-03-2026' })).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

describe('admin reference data', () => {
  it('lists active and inactive rows including read-only pendidikan', async () => {
    const res = await call('/api/admin/ref', { cookie: admin });
    expect(res.status).toBe(200);
    const body = await json<AdminRefResponse>(res);
    expect(body.pangkat.find((p) => p.kode === 'III/a')).toEqual({
      kode: 'III/a', nama: 'Penata Muda (III/a)', jenisAsn: 'PNS', urutan: 9, aktif: true,
    });
    expect(body.unit.length).toBeGreaterThanOrEqual(3);
    expect(body.pendidikan.map((p) => p.kode)).toContain('S1');
    expect((await call('/api/admin/ref/pendidikan', { cookie: admin, body: { kode: 'X', nama: 'X' } })).status).toBe(404);
  });

  it('creates, edits and deactivates pangkat; kode/jenisAsn immutable; audit lists field names only', async () => {
    const kode = `T/${rnd().toLowerCase()}`;
    const nama = `Pangkat Uji ${rnd()}`;
    const created = await call('/api/admin/ref/pangkat', { cookie: admin, body: { kode, nama, jenisAsn: 'PPPK', urutan: 500 } });
    expect(created.status).toBe(201);
    expect((await json<{ item: unknown }>(created)).item).toEqual({ kode, nama, jenisAsn: 'PPPK', urutan: 500, aktif: true });

    const path = `/api/admin/ref/pangkat/${encodeURIComponent(kode)}`;
    expect((await call(path, { method: 'PATCH', cookie: admin, body: { kode: 'NEW' } })).status).toBe(400);
    expect((await call(path, { method: 'PATCH', cookie: admin, body: { jenisAsn: 'PNS' } })).status).toBe(400);
    expect((await call(path, { method: 'PATCH', cookie: admin, body: {} })).status).toBe(400);

    const off = await call(path, { method: 'PATCH', cookie: admin, body: { aktif: false } });
    expect((await json<{ item: { aktif: boolean } }>(off)).item.aktif).toBe(false);
    // Omitted aktif on a later PATCH must not reactivate it.
    const renamed = await call(path, { method: 'PATCH', cookie: admin, body: { urutan: 501 } });
    expect((await json<{ item: unknown }>(renamed)).item).toEqual({ kode, nama, jenisAsn: 'PPPK', urutan: 501, aktif: false });

    const audits = await env.DB.prepare(
      `SELECT action, description FROM log_aktivitas WHERE target_type = 'ref_pangkat_golongan' AND target_id = ?1 ORDER BY id`,
    )
      .bind(kode)
      .all<{ action: string; description: string }>();
    expect(audits.results.map((r) => r.action)).toEqual(['REF_CREATE', 'REF_UPDATE', 'REF_UPDATE']);
    expect(audits.results[2]!.description).toContain('urutan');
    expect(JSON.stringify(audits.results)).not.toContain(nama);
    expect(JSON.stringify(audits.results)).not.toContain('501');
  });

  it('rejects exact dot-segment codes but accepts dotted codes with an encoded slash', async () => {
    for (const kode of ['.', '..']) {
      const res = await call('/api/admin/ref/pangkat', {
        cookie: admin,
        body: { kode, nama: `Pangkat Dot ${rnd()}`, jenisAsn: 'PNS', urutan: 600 },
      });
      expect(res.status, kode).toBe(400);
      expect((await errorOf(res)).fields).toHaveProperty('kode');
      expect(await countAudit('REF_CREATE', kode)).toBe(0);
      expect(await env.DB.prepare(`SELECT kode FROM ref_pangkat_golongan WHERE kode = ?1`).bind(kode).first()).toBeNull();
    }

    const kode = `T.${rnd()}/a`;
    const nama = `Pangkat Dotted ${rnd()}`;
    const created = await call('/api/admin/ref/pangkat', {
      cookie: admin,
      body: { kode, nama, jenisAsn: 'PNS', urutan: 600 },
    });
    expect(created.status).toBe(201);
    expect((await json<{ item: { kode: string } }>(created)).item.kode).toBe(kode);

    const updated = await call(`/api/admin/ref/pangkat/${encodeURIComponent(kode)}`, {
      method: 'PATCH', cookie: admin, body: { urutan: 601 },
    });
    expect(updated.status).toBe(200);
    expect((await json<{ item: { kode: string; urutan: number } }>(updated)).item).toMatchObject({ kode, urutan: 601 });
  });

  it('accepts a 16-character pangkat code across admin employee creation and employee pengajuan; rejects 17', async () => {
    const kode = `PNS.${rnd()}.12345`;
    const nama = `Pangkat Batas ${rnd()}`;
    expect(kode).toHaveLength(16);
    const ref = await call('/api/admin/ref/pangkat', {
      cookie: admin,
      body: { kode, nama, jenisAsn: 'PNS', urutan: 700 },
    });
    expect(ref.status).toBe(201);
    expect((await json<{ item: { kode: string } }>(ref)).item.kode).toBe(kode);

    const tooLong = `${kode}X`;
    expect(tooLong).toHaveLength(17);
    const rejected = await call('/api/admin/ref/pangkat', {
      cookie: admin,
      body: { kode: tooLong, nama: `Pangkat Lebih ${rnd()}`, jenisAsn: 'PNS', urutan: 701 },
    });
    expect(rejected.status).toBe(400);
    expect((await errorOf(rejected)).fields).toHaveProperty('kode');
    expect(await countAudit('REF_CREATE', tooLong)).toBe(0);

    const nip = uniqueNip();
    const employeeName = `Pegawai Batas ${rnd()}`;
    const created = await call('/api/admin/pegawai', {
      cookie: admin,
      body: { nip, nama: employeeName, statusKepegawaian: 'PNS', pangkatKode: kode },
    });
    expect(created.status).toBe(201);
    const { pegawai: assigned } = await json<{ pegawai: { id: number; pangkatKode: string | null } }>(created);
    expect(assigned.pangkatKode).toBe(kode);
    const stored = await env.DB.prepare(`SELECT pangkat_kode FROM pegawai WHERE id = ?1`).bind(assigned.id).first();
    expect(stored).toEqual({ pangkat_kode: kode });

    const existing = await createUser(); // Existing PNS employee, no pending request.
    const cookie = await login(existing);
    const alasan = `Penyesuaian pangkat sesuai dokumen uji ${rnd()}`;
    const submitted = await call('/api/me/pengajuan', {
      cookie,
      body: { perubahan: { pangkatKode: kode }, alasan },
    });
    expect(submitted.status).toBe(201);
    const pengajuan = await json<{ pengajuan: { pegawaiId: number; perubahan: { pangkatKode: { lama: null; baru: string } } } }>(submitted);
    expect(pengajuan.pengajuan.pegawaiId).toBe(existing.id);
    expect(pengajuan.pengajuan.perubahan.pangkatKode).toEqual({ lama: null, baru: kode });
    // Submission records a request; it must not directly change the employee's rank.
    const unchanged = await env.DB.prepare(`SELECT pangkat_kode FROM pegawai WHERE id = ?1`).bind(existing.id).first();
    expect(unchanged).toEqual({ pangkat_kode: null });

    const audits = await env.DB.prepare(
      `SELECT action, description FROM log_aktivitas
        WHERE (action = 'REF_CREATE' AND target_id = ?1)
           OR (action = 'PEGAWAI_CREATE' AND target_id = ?2)
           OR (action = 'PENGAJUAN_CREATE' AND target_id = ?3)`,
    )
      .bind(kode, String(assigned.id), String(existing.id))
      .all<{ action: string; description: string }>();
    expect(audits.results).toHaveLength(3);
    expect(audits.results.find((a) => a.action === 'PENGAJUAN_CREATE')!.description).toContain('pangkatKode');
    const descriptions = JSON.stringify(audits.results);
    for (const value of [kode, nama, nip, employeeName, existing.nip, alasan]) expect(descriptions).not.toContain(value);
  });

  it('routes URI-encoded slash codes (III%2Fa) and 404s unknown keys', async () => {
    const res = await call('/api/admin/ref/pangkat/III%2Fa', { method: 'PATCH', cookie: admin, body: { urutan: 9 } });
    expect(res.status).toBe(200);
    expect((await json<{ item: { kode: string } }>(res)).item.kode).toBe('III/a');
    expect((await call('/api/admin/ref/pangkat/NOPE%2Fz', { method: 'PATCH', cookie: admin, body: { urutan: 1 } })).status).toBe(404);
    expect((await call('/api/admin/ref/pangkat/..%2F..%2Fx%20y', { method: 'PATCH', cookie: admin, body: { urutan: 1 } })).status).toBe(404);
    expect((await call('/api/admin/ref/unit/999999', { method: 'PATCH', cookie: admin, body: { aktif: false } })).status).toBe(404);
    expect((await call('/api/admin/ref/unit/abc', { method: 'PATCH', cookie: admin, body: { aktif: false } })).status).toBe(404);
    expect(await countAudit('REF_UPDATE', 'NOPE/z')).toBe(0);
  });

  it('rejects duplicate pangkat kode/nama and unit nama (case-insensitive) with 409 fields', async () => {
    const dupKode = await call('/api/admin/ref/pangkat', {
      cookie: admin, body: { kode: 'iii/A', nama: `Baru ${rnd()}`, jenisAsn: 'PNS', urutan: 1 },
    });
    expect(dupKode.status).toBe(409);
    expect((await errorOf(dupKode)).fields).toHaveProperty('kode');
    const dupNama = await call('/api/admin/ref/pangkat', {
      cookie: admin, body: { kode: `Z${rnd()}`, nama: 'penata muda (iii/a)', jenisAsn: 'PNS', urutan: 1 },
    });
    expect(dupNama.status).toBe(409);
    expect((await errorOf(dupNama)).fields).toHaveProperty('nama');
    const renameDup = await call('/api/admin/ref/pangkat/III%2Fb', { method: 'PATCH', cookie: admin, body: { nama: 'Penata Muda (III/a)' } });
    expect(renameDup.status).toBe(409);
    expect((await errorOf(renameDup)).fields).toHaveProperty('nama');

    const unitDup = await call('/api/admin/ref/unit', { cookie: admin, body: { nama: 'seksi verifikasi' } });
    expect(unitDup.status).toBe(409);
    expect((await errorOf(unitDup)).fields).toHaveProperty('nama');
    const u = await json<{ item: { id: number } }>(await call('/api/admin/ref/unit', { cookie: admin, body: { nama: `Unit ${rnd()}` } }));
    const unitRename = await call(`/api/admin/ref/unit/${u.item.id}`, { method: 'PATCH', cookie: admin, body: { nama: 'Seksi Verifikasi' } });
    expect(unitRename.status).toBe(409);
    expect((await call('/api/admin/ref/unit', { cookie: admin, body: { nama: 'X', extra: 1 } })).status).toBe(400);
  });

  it('deactivated unit is hidden from employee /api/ref but existing profiles keep it', async () => {
    const created = await call('/api/admin/ref/unit', { cookie: admin, body: { nama: `Unit Lama ${rnd()}` } });
    expect(created.status).toBe(201);
    const { item } = await json<{ item: { id: number; nama: string; aktif: boolean } }>(created);
    expect(await countAudit('REF_CREATE', String(item.id))).toBe(1);

    const emp = await person();
    await env.DB.prepare(`UPDATE pegawai SET unit_id = ?1 WHERE id = ?2`).bind(item.id, emp.user.id).run();

    const off = await call(`/api/admin/ref/unit/${item.id}`, { method: 'PATCH', cookie: admin, body: { aktif: false } });
    expect((await json<{ item: unknown }>(off)).item).toEqual({ ...item, aktif: false });
    const again = await call(`/api/admin/ref/unit/${item.id}`, { method: 'PATCH', cookie: admin, body: { nama: `${item.nama} B` } });
    expect((await json<{ item: { aktif: boolean } }>(again)).item.aktif).toBe(false);

    const ref = await json<RefResponse>(await call('/api/ref', { cookie: emp.cookie }));
    expect(ref.unit.some((u) => u.id === item.id)).toBe(false);
    const profile = await json<{ profile: { unitId: number | null } }>(await call('/api/me/profile', { cookie: emp.cookie }));
    expect(profile.profile.unitId).toBe(item.id);
    const all = await json<AdminRefResponse>(await call('/api/admin/ref', { cookie: admin }));
    expect(all.unit.find((u) => u.id === item.id)?.aktif).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Jenis dokumen
// ---------------------------------------------------------------------------

function jenisBody(id: string, extra: Record<string, unknown> = {}) {
  return { id, nama: `Dokumen ${id}`, kategori: 'Dokumen Uji', urutan: 900, maxSizeBytes: 1024 * 1024, wajibUntuk: ['PNS'], ...extra };
}

async function createJenis(id: string, extra: Record<string, unknown> = {}): Promise<AdminJenisDokumen> {
  const res = await call('/api/admin/jenis-dokumen', { cookie: admin, body: jenisBody(id, extra) });
  expect(res.status).toBe(201);
  return (await json<{ item: AdminJenisDokumen }>(res)).item;
}

async function patchJenis(id: string, body: unknown): Promise<Response> {
  return call(`/api/admin/jenis-dokumen/${encodeURIComponent(id)}`, { method: 'PATCH', cookie: admin, body });
}

async function wajibOf(id: string): Promise<string[]> {
  const r = await env.DB.prepare(
    `SELECT status_kepegawaian AS s FROM jenis_dokumen_wajib WHERE jenis_dokumen_id = ?1 ORDER BY s`,
  )
    .bind(id)
    .all<{ s: string }>();
  return r.results.map((x) => x.s);
}

function authFor(id: number): AuthContext {
  return {
    user: { id, nip: '199001012020011099', nama: 'Admin Uji', role: 'Admin', statusKepegawaian: null, jabatan: null, fotoR2Key: null, isDefaultPassword: false },
    tokenHash: 'x',
  };
}

describe('admin jenis dokumen', () => {
  it('lists seeded types with updatedAt epoch default and matrix', async () => {
    const body = await json<AdminJenisResponse>(await call('/api/admin/jenis-dokumen', { cookie: admin }));
    const ktp = body.items.find((i) => i.id === 'DOC-KTP')!;
    expect(ktp.wajibUntuk).toEqual(['PNS', 'CPNS', 'PPPK']);
    expect(ktp.updatedAt).toBe('1970-01-01T00:00:00.000Z');
    expect(body.items.find((i) => i.id === 'DOC-KARPEG')!.wajibUntuk).toEqual([]);
  });

  it('create + matrix update apply retroactively to employee dashboard and admin document list', async () => {
    const emp = await person(); // status PNS
    const before = await json<DashboardResponse>(await call('/api/me/dashboard', { cookie: emp.cookie }));
    const id = `DOC-T${rnd()}`;
    const item = await createJenis(id);
    expect(item).toMatchObject({ id, aktif: true, wajibUntuk: ['PNS'], maxSizeBytes: 1024 * 1024 });
    expect(await countAudit('JENIS_DOKUMEN_CREATE', id)).toBe(1);

    const after = await json<DashboardResponse>(await call('/api/me/dashboard', { cookie: emp.cookie }));
    expect(after.dokumen.wajibTotal).toBe(before.dokumen.wajibTotal + 1);
    const docs = await json<DokumenListResponse>(await call(`/api/admin/pegawai/${emp.user.id}/documents`, { cookie: admin }));
    expect(docs.items.find((d) => d.jenisDokumenId === id)?.wajib).toBe(true);

    const patched = await patchJenis(id, { wajibUntuk: ['CPNS', 'PPPK'], expectedUpdatedAt: item.updatedAt });
    expect(patched.status).toBe(200);
    const p = (await json<{ item: AdminJenisDokumen }>(patched)).item;
    expect(p.wajibUntuk).toEqual(['CPNS', 'PPPK']);
    expect(p.updatedAt > item.updatedAt).toBe(true);
    expect(await wajibOf(id)).toEqual(['CPNS', 'PPPK']);
    const later = await json<DashboardResponse>(await call('/api/me/dashboard', { cookie: emp.cookie }));
    expect(later.dokumen.wajibTotal).toBe(before.dokumen.wajibTotal);

    const audit = await env.DB.prepare(
      `SELECT description FROM log_aktivitas WHERE action = 'JENIS_DOKUMEN_UPDATE' AND target_id = ?1`,
    )
      .bind(id)
      .first<{ description: string }>();
    expect(audit!.description).toContain('wajibUntuk');
    expect(audit!.description).not.toContain('expectedUpdatedAt');
    expect(audit!.description).not.toContain('CPNS');
  });

  it('stale expectedUpdatedAt -> 409 stale; matrix and row unchanged; no audit', async () => {
    const id = `DOC-S${rnd()}`;
    const item = await createJenis(id, { wajibUntuk: ['PNS', 'CPNS'] });
    const ok = await patchJenis(id, { nama: `Baru ${id}`, expectedUpdatedAt: item.updatedAt });
    expect(ok.status).toBe(200);
    const stale = await patchJenis(id, { wajibUntuk: [], aktif: false, expectedUpdatedAt: item.updatedAt });
    expect(stale.status).toBe(409);
    expect((await errorOf(stale)).fields).toHaveProperty('stale');
    expect(await wajibOf(id)).toEqual(['CPNS', 'PNS']);
    const row = await env.DB.prepare(`SELECT aktif FROM jenis_dokumen WHERE id = ?1`).bind(id).first<{ aktif: number }>();
    expect(row!.aktif).toBe(1);
    expect(await countAudit('JENIS_DOKUMEN_UPDATE', id)).toBe(1);
  });

  it('batch CAS: a stale stamp gates matrix DELETE, INSERT, UPDATE and audit', async () => {
    const id = `DOC-C${rnd()}`;
    const item = await createJenis(id, { wajibUntuk: ['PPPK'] });
    const db = env.DB;
    const staleStamp = '2000-01-01T00:00:00.000Z';
    const results = await db.batch([
      deleteWajibIfStamp(db, id, staleStamp),
      insertWajibIfStamp(db, id, staleStamp, ['PNS', 'CPNS']),
      updateJenisIfStamp(db, id, staleStamp, '2099-01-01T00:00:00.000Z', { nama: 'X', kategori: null, urutan: null, aktif: 0, maxSizeBytes: null }),
      auditStatement(db, { actor: null, action: 'JENIS_DOKUMEN_UPDATE', targetId: id, result: 'SUCCESS' }, { onlyIfPreviousChanged: true }),
    ]);
    expect(results.map((r) => r.meta.changes)).toEqual([0, 0, 0, 0]);
    expect(await wajibOf(id)).toEqual(['PPPK']);
    const row = await db.prepare(`SELECT nama, aktif, updated_at FROM jenis_dokumen WHERE id = ?1`).bind(id).first();
    expect(row).toEqual({ nama: item.nama, aktif: 1, updated_at: item.updatedAt });
    expect(await countAudit('JENIS_DOKUMEN_UPDATE', id)).toBe(0);
  });

  it('concurrent PATCHes never merge or wipe the matrix; audits match successes', async () => {
    const id = `DOC-R${rnd()}`;
    const item = await createJenis(id, { wajibUntuk: ['PPPK'] });
    const nowMs = Date.now();
    const meta = { ip: null, userAgent: null, nowMs };
    const outcomes = await Promise.allSettled([
      updateJenis(env, authFor(adminId), id, { wajibUntuk: ['PNS'], expectedUpdatedAt: item.updatedAt }, meta),
      updateJenis(env, authFor(adminId), id, { wajibUntuk: ['CPNS', 'PPPK'], expectedUpdatedAt: item.updatedAt }, meta),
    ]);
    const ok = outcomes.filter((o): o is PromiseFulfilledResult<{ item: AdminJenisDokumen }> => o.status === 'fulfilled');
    expect(ok.length).toBeGreaterThanOrEqual(1);
    for (const o of outcomes) if (o.status === 'rejected') expect((o.reason as { status: number }).status).toBe(409);
    const final = await wajibOf(id);
    expect([['PNS'], ['CPNS', 'PPPK']]).toContainEqual(final);
    expect(await countAudit('JENIS_DOKUMEN_UPDATE', id)).toBe(ok.length);
  });

  it('updatedAt bump is strictly monotonic within the same millisecond', async () => {
    const id = `DOC-M${rnd()}`;
    await createJenis(id);
    const meta = { ip: null, userAgent: null, nowMs: Date.parse('2001-01-01T00:00:00.000Z') };
    const a = await updateJenis(env, authFor(adminId), id, { urutan: 1 }, meta);
    const b = await updateJenis(env, authFor(adminId), id, { urutan: 2 }, meta);
    const c = await updateJenis(env, authFor(adminId), id, { urutan: 3, expectedUpdatedAt: b.item.updatedAt }, meta);
    expect(b.item.updatedAt > a.item.updatedAt).toBe(true);
    expect(c.item.updatedAt > b.item.updatedAt).toBe(true);
    expect(c.item.urutan).toBe(3);
  });

  it('id is immutable, validated and path-safe; duplicates 409; unknown 404', async () => {
    const id = `DOC-I${rnd()}`;
    await createJenis(id);
    expect((await patchJenis(id, { id: 'DOC-OTHER' })).status).toBe(400);
    expect((await patchJenis(id, {})).status).toBe(400);
    expect((await patchJenis(id, { expectedUpdatedAt: '2026-01-01T00:00:00.000Z' })).status).toBe(400);
    expect((await patchJenis(id, { wajibUntuk: ['PNS', 'PNS'] })).status).toBe(400);
    expect((await patchJenis(id, { wajibUntuk: ['HONORER'] })).status).toBe(400);

    for (const bad of ['../etc', 'DOC-../X', 'doc-lower', 'DOC-', 'DOC-A/B', 'DOC-A B', 'KTP', `DOC-${'A'.repeat(70)}`, 'DOC-A--B']) {
      const res = await call('/api/admin/jenis-dokumen', { cookie: admin, body: jenisBody(bad) });
      expect(res.status, bad).toBe(400);
    }
    const dup = await call('/api/admin/jenis-dokumen', { cookie: admin, body: jenisBody('DOC-KTP') });
    expect(dup.status).toBe(409);
    expect((await errorOf(dup)).fields).toHaveProperty('id');
    const ktp = await json<AdminJenisResponse>(await call('/api/admin/jenis-dokumen', { cookie: admin }));
    expect(ktp.items.find((i) => i.id === 'DOC-KTP')!.nama).toBe('Kartu Tanda Penduduk (KTP)');

    expect((await patchJenis('DOC-NOPE-X', { urutan: 1 })).status).toBe(404);
    const trav = await call('/api/admin/jenis-dokumen/..%2F..%2Fsecret', { method: 'PATCH', cookie: admin, body: { urutan: 1 } });
    expect(trav.status).toBe(404);
  });

  it('enforces maxSizeBytes bounds (1 KiB .. 5 MB)', async () => {
    const max = 5 * 1024 * 1024;
    expect((await call('/api/admin/jenis-dokumen', { cookie: admin, body: jenisBody(`DOC-B${rnd()}`, { maxSizeBytes: max + 1 }) })).status).toBe(400);
    expect((await call('/api/admin/jenis-dokumen', { cookie: admin, body: jenisBody(`DOC-B${rnd()}`, { maxSizeBytes: 1023 }) })).status).toBe(400);
    expect((await call('/api/admin/jenis-dokumen', { cookie: admin, body: jenisBody(`DOC-B${rnd()}`, { maxSizeBytes: 1.5 }) })).status).toBe(400);
    const item = await createJenis(`DOC-B${rnd()}`, { maxSizeBytes: max });
    expect(item.maxSizeBytes).toBe(max);
    expect((await patchJenis(item.id, { maxSizeBytes: max + 1 })).status).toBe(400);
    const ok = await patchJenis(item.id, { maxSizeBytes: 1024 });
    expect((await json<{ item: AdminJenisDokumen }>(ok)).item.maxSizeBytes).toBe(1024);
  });

  it('deactivation removes the type from completeness but keeps archives; omitted aktif stays false', async () => {
    const emp = await person();
    const id = `DOC-D${rnd()}`;
    const item = await createJenis(id);
    const arsipId = await insertArsip(emp.user.id, id, { status: 'Terverifikasi' });
    const withType = await json<DashboardResponse>(await call('/api/me/dashboard', { cookie: emp.cookie }));

    const off = await patchJenis(id, { aktif: false, expectedUpdatedAt: item.updatedAt });
    expect((await json<{ item: AdminJenisDokumen }>(off)).item).toMatchObject({ aktif: false, wajibUntuk: ['PNS'] });
    const without = await json<DashboardResponse>(await call('/api/me/dashboard', { cookie: emp.cookie }));
    expect(without.dokumen.wajibTotal).toBe(withType.dokumen.wajibTotal - 1);
    const arsip = await env.DB.prepare(`SELECT id, deleted_at FROM arsip_dokumen WHERE id = ?1`).bind(arsipId).first();
    expect(arsip).toEqual({ id: arsipId, deleted_at: null });

    const renamed = await patchJenis(id, { nama: `Nonaktif ${id}` });
    expect((await json<{ item: AdminJenisDokumen }>(renamed)).item.aktif).toBe(false);
    const all = await json<AdminJenisResponse>(await call('/api/admin/jenis-dokumen', { cookie: admin }));
    expect(all.items.find((i) => i.id === id)?.aktif).toBe(false);
    const ref = await json<RefResponse>(await call('/api/ref', { cookie: emp.cookie }));
    expect(ref.jenisDokumen.some((j) => j.id === id)).toBe(false);
  });
});
