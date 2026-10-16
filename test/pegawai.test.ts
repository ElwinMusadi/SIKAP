// Phase 6 Part A: admin Master Data Pegawai (list, detail, create, update).
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { PegawaiDetailResponse, PegawaiListItem, PegawaiListResponse } from '../shared/pegawai';
import { updatePegawai } from '../server/services/pegawai';
import { call, json, login, uniqueNip } from './helpers';
import { insertArsip, person } from './phase5-helpers';

let admin: Awaited<ReturnType<typeof person>>;
let pegawai: Awaited<ReturnType<typeof person>>;

beforeAll(async () => {
  admin = await person({ role: 'Admin' });
  pegawai = await person();
});

let tagSeq = 0;
/** Unique, LIKE-safe marker for scoping list queries to one test's fixtures. */
function tag(): string {
  tagSeq += 1;
  return `Zq${Math.random().toString(36).slice(2, 7)}${tagSeq}`;
}

let nikSeq = 0;
function uniqueNik(): string {
  nikSeq += 1;
  return `51${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}${String(nikSeq).padStart(8, '0')}`;
}

interface Fixture {
  id: number;
  nip: string;
}

async function mk(
  opts: {
    nama: string;
    status?: 'PNS' | 'CPNS' | 'PPPK' | null;
    statusAkun?: 'Aktif' | 'Nonaktif';
    deleted?: { by?: number; expired?: boolean };
    akun?: { isDefault: 0 | 1; lockedUntil?: string };
    nip?: string;
  },
): Promise<Fixture> {
  const nip = opts.nip ?? uniqueNip();
  const now = Date.now();
  const deletedAt = opts.deleted ? new Date(now - 1000).toISOString() : null;
  const purge = opts.deleted
    ? new Date(opts.deleted.expired ? now - 500 : now + 7 * 86_400_000).toISOString()
    : null;
  const row = await env.DB.prepare(
    `INSERT INTO pegawai (nip, nama, status_kepegawaian, status_akun, deleted_at, deleted_by, purge_after)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) RETURNING id`,
  )
    .bind(
      nip,
      opts.nama,
      opts.status === undefined ? 'PNS' : opts.status,
      opts.statusAkun ?? 'Aktif',
      deletedAt,
      opts.deleted?.by ?? null,
      purge,
    )
    .first<{ id: number }>();
  if (opts.akun) {
    await env.DB.prepare(
      `INSERT INTO akun (pegawai_id, password_hash, is_default_password, locked_until) VALUES (?1, 'x', ?2, ?3)`,
    )
      .bind(row!.id, opts.akun.isDefault, opts.akun.lockedUntil ?? null)
      .run();
  }
  return { id: row!.id, nip };
}

async function wajibFor(status: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT w.jenis_dokumen_id AS id FROM jenis_dokumen_wajib w
       JOIN jenis_dokumen j ON j.id = w.jenis_dokumen_id AND j.aktif = 1
      WHERE w.status_kepegawaian = ?1`,
  )
    .bind(status)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

async function list(query: string): Promise<{ status: number; body: PegawaiListResponse }> {
  const res = await call(`/api/admin/pegawai?${query}`, { cookie: admin.cookie });
  return { status: res.status, body: await json<PegawaiListResponse>(res) };
}

function ids(items: PegawaiListItem[]): number[] {
  return items.map((i) => i.id);
}

describe('access control', () => {
  it('rejects a Pegawai on every Master Data route', async () => {
    const c = pegawai.cookie;
    const target = admin.user.id;
    const responses = await Promise.all([
      call('/api/admin/pegawai', { cookie: c }),
      call(`/api/admin/pegawai/${target}`, { cookie: c }),
      call('/api/admin/pegawai', { cookie: c, body: { nip: uniqueNip(), nama: 'Orang Baru', statusKepegawaian: 'PNS' } }),
      call(`/api/admin/pegawai/${target}`, { cookie: c, method: 'PATCH', body: { jabatan: 'X' } }),
    ]);
    expect(responses.map((r) => r.status)).toEqual([403, 403, 403, 403]);
  });
});

describe('GET /api/admin/pegawai', () => {
  it('searches nama and nip; % and _ are literal', async () => {
    const t = tag();
    const a = await mk({ nama: `Ab%cd ${t}` });
    const b = await mk({ nama: `Abxcd ${t}` });
    const c = await mk({ nama: `A_b ${t}` });

    const all = await list(`q=${encodeURIComponent(t)}`);
    expect(all.status).toBe(200);
    expect(ids(all.body.items).sort()).toEqual([a.id, b.id, c.id].sort());

    expect(ids((await list(`q=${encodeURIComponent('b%c')}`)).body.items)).toEqual([a.id]);
    expect(ids((await list(`q=${encodeURIComponent('A_b')}`)).body.items)).toEqual([c.id]);
    expect(ids((await list(`q=${b.nip.slice(4)}`)).body.items)).toEqual([b.id]);
  });

  it('filters statusKepegawaian, statusAkun and passwordDefault', async () => {
    const t = tag();
    const pns = await mk({ nama: `Pns ${t}`, akun: { isDefault: 1 } });
    const pppk = await mk({ nama: `Pppk ${t}`, status: 'PPPK', akun: { isDefault: 0 } });
    const off = await mk({ nama: `Off ${t}`, statusAkun: 'Nonaktif', akun: { isDefault: 0 } });

    expect(ids((await list(`q=${t}&statusKepegawaian=PPPK`)).body.items)).toEqual([pppk.id]);
    expect(ids((await list(`q=${t}&statusAkun=Nonaktif`)).body.items)).toEqual([off.id]);
    expect(ids((await list(`q=${t}&passwordDefault=true`)).body.items)).toEqual([pns.id]);
    const pnsAktif = await list(`q=${t}&statusKepegawaian=PNS&statusAkun=Aktif`);
    expect(ids(pnsAktif.body.items)).toEqual([pns.id]);
    const item = pnsAktif.body.items[0]!;
    expect(item.isDefaultPassword).toBe(true);
    expect(item.terkunci).toBe(false);
  });

  it('derives kelengkapan, filters and sorts by it', async () => {
    const t = tag();
    const wajib = await wajibFor('PNS');
    expect(wajib.length).toBeGreaterThan(1);

    const lengkap = await mk({ nama: `C Lengkap ${t}` });
    for (const j of wajib) await insertArsip(lengkap.id, j, { status: 'Terverifikasi' });
    const revisi = await mk({ nama: `B Revisi ${t}` });
    await insertArsip(revisi.id, wajib[0]!, { status: 'Ditolak' });
    await insertArsip(revisi.id, wajib[1]!, { status: 'Menunggu' });
    const belum = await mk({ nama: `A Belum ${t}` });
    await insertArsip(belum.id, wajib[0]!, { status: 'Terverifikasi' });
    const kosong = await mk({ nama: `D Kosong ${t}`, status: null });

    const res = await list(`q=${t}`);
    const byId = new Map(res.body.items.map((i) => [i.id, i]));
    expect(byId.get(lengkap.id)!.dokumen).toMatchObject({
      kelengkapan: 'Lengkap',
      persen: 100,
      wajibTotal: wajib.length,
      wajibTerverifikasi: wajib.length,
    });
    expect(byId.get(revisi.id)!.dokumen).toMatchObject({ kelengkapan: 'Perlu Revisi', menunggu: 1 });
    expect(byId.get(belum.id)!.dokumen).toMatchObject({
      kelengkapan: 'Belum Lengkap',
      wajibTerverifikasi: 1,
      persen: Math.round((1 / wajib.length) * 100),
    });
    expect(byId.get(kosong.id)!.dokumen).toMatchObject({ kelengkapan: 'Belum Lengkap', wajibTotal: 0, persen: 0 });

    expect(ids((await list(`q=${t}&kelengkapan=Lengkap`)).body.items)).toEqual([lengkap.id]);
    expect(ids((await list(`q=${t}&kelengkapan=Perlu%20Revisi`)).body.items)).toEqual([revisi.id]);
    expect(ids((await list(`q=${t}&kelengkapan=Belum%20Lengkap`)).body.items).sort()).toEqual(
      [belum.id, kosong.id].sort(),
    );

    // asc: Perlu Revisi, then Belum Lengkap (least progress first), then Lengkap.
    expect(ids((await list(`q=${t}&sort=kelengkapan&dir=asc`)).body.items)).toEqual([
      revisi.id,
      kosong.id,
      belum.id,
      lengkap.id,
    ]);
    expect(ids((await list(`q=${t}&sort=nama&dir=desc`)).body.items)).toEqual([
      kosong.id,
      lengkap.id,
      revisi.id,
      belum.id,
    ]);
  });

  it('belumUnggah returns only employees for whom the document is mandatory and missing', async () => {
    const t = tag();
    expect(await wajibFor('PNS')).toContain('DOC-NPWP');
    const missing = await mk({ nama: `Missing ${t}` });
    const has = await mk({ nama: `Has ${t}` });
    await insertArsip(has.id, 'DOC-NPWP', { status: 'Menunggu' });
    const deletedArsip = await mk({ nama: `DelArsip ${t}` });
    await insertArsip(deletedArsip.id, 'DOC-NPWP', { status: 'Terverifikasi', deleted: true });
    await mk({ nama: `NoStatus ${t}`, status: null });

    const res = await list(`q=${t}&belumUnggah=DOC-NPWP`);
    expect(ids(res.body.items).sort()).toEqual([missing.id, deletedArsip.id].sort());
    expect(res.body.total).toBe(2);
  });

  it('terhapus shows only soft-deleted rows within retention, with deletedBy', async () => {
    const t = tag();
    const live = await mk({ nama: `Live ${t}` });
    const gone = await mk({ nama: `Gone ${t}`, deleted: { by: admin.user.id } });
    await mk({ nama: `Expired ${t}`, deleted: { expired: true } });

    const normal = await list(`q=${t}`);
    expect(ids(normal.body.items)).toEqual([live.id]);
    expect(normal.body.items[0]!.deleted).toBeNull();

    const trash = await list(`q=${t}&terhapus=true`);
    expect(ids(trash.body.items)).toEqual([gone.id]);
    expect(trash.body.items[0]!.deleted).toMatchObject({ deletedBy: { id: admin.user.id } });
    expect(trash.body.items[0]!.deleted!.deletedBy!.nama).toBeTruthy();
    expect(trash.body.summary.terhapus).toBeGreaterThanOrEqual(1);
  });

  it('pages with a total and reports a lock', async () => {
    const t = tag();
    const future = new Date(Date.now() + 3_600_000).toISOString();
    for (let i = 0; i < 3; i++) await mk({ nama: `Page${i} ${t}`, akun: { isDefault: 0, lockedUntil: future } });
    const p1 = await list(`q=${t}&pageSize=15&page=1`);
    expect(p1.body.total).toBe(3);
    expect(p1.body.items).toHaveLength(3);
    expect(p1.body.items.every((i) => i.terkunci)).toBe(true);
    expect(p1.body.summary.total).toBeGreaterThanOrEqual(3);
    const p2 = await list(`q=${t}&page=2`);
    expect(p2.body.total).toBe(3);
    expect(p2.body.items).toHaveLength(0);
  });

  it('rejects invalid query parameters', async () => {
    expect((await list('pageSize=7')).status).toBe(400);
    expect((await list(`sort=${encodeURIComponent('nama;DROP TABLE pegawai')}`)).status).toBe(400);
    expect((await list('dir=sideways')).status).toBe(400);
    expect((await list('kelengkapan=Semua')).status).toBe(400);
  });
});

describe('GET /api/admin/pegawai/:id', () => {
  it('returns profile and account state with active sessions', async () => {
    const res = await call(`/api/admin/pegawai/${pegawai.user.id}`, { cookie: admin.cookie });
    expect(res.status).toBe(200);
    const body = await json<PegawaiDetailResponse>(res);
    expect(body.pegawai.nip).toBe(pegawai.user.nip);
    expect(body.akun.sesiAktif).toBeGreaterThanOrEqual(1);
    expect(body.akun.isDefaultPassword).toBe(true);
    expect(body.pengajuanAktif).toBeNull();
  });

  it('404 for unknown, malformed and soft-deleted ids', async () => {
    const gone = await mk({ nama: `Deleted ${tag()}`, deleted: {} });
    for (const id of ['999999999', 'abc', '0', String(gone.id)]) {
      expect((await call(`/api/admin/pegawai/${id}`, { cookie: admin.cookie })).status).toBe(404);
    }
  });
});

describe('POST /api/admin/pegawai', () => {
  it('creates pegawai + akun with the default password', async () => {
    const nip = uniqueNip();
    const nik = uniqueNik();
    const res = await call('/api/admin/pegawai', {
      cookie: admin.cookie,
      body: { nip, nama: 'Pegawai Baru', statusKepegawaian: 'PNS', pangkatKode: 'III/a', unitId: 1, nik, pendidikanKode: 'SMA' },
    });
    expect(res.status).toBe(201);
    const body = await json<PegawaiDetailResponse>(res);
    expect(body.pegawai).toMatchObject({ nip, nama: 'Pegawai Baru', role: 'Pegawai', pangkatKode: 'III/a', nik });
    expect(body.akun.isDefaultPassword).toBe(true);

    const cookie = await login({ id: body.pegawai.id, nip, password: nip.slice(-6) });
    const me = await call('/api/auth/me', { cookie });
    expect(me.status).toBe(200);
    expect(JSON.stringify(await me.json())).toContain('"isDefaultPassword":true');

    const audit = await env.DB.prepare(
      `SELECT description, target_id FROM log_aktivitas WHERE action = 'PEGAWAI_CREATE' AND target_id = ?1`,
    )
      .bind(String(body.pegawai.id))
      .first<{ description: string; target_id: string }>();
    expect(audit).not.toBeNull();
    expect(audit!.description).not.toContain(nik);
    expect(audit!.description).not.toContain(nip);
  });

  it('409 on duplicate NIP, with the restore message for a soft-deleted owner', async () => {
    const dup = await call('/api/admin/pegawai', {
      cookie: admin.cookie,
      body: { nip: pegawai.user.nip, nama: 'Duplikat', statusKepegawaian: 'PNS' },
    });
    expect(dup.status).toBe(409);
    const dupBody = (await dup.json()) as { error: { message: string; fields?: Record<string, string> } };
    expect(dupBody.error.message).toBe('NIP sudah terdaftar.');
    // Machine-readable key: clients must not branch on message text.
    expect(Object.keys(dupBody.error.fields ?? {})).toEqual(['nip']);

    const gone = await mk({ nama: `Deleted ${tag()}`, deleted: {} });
    const res = await call('/api/admin/pegawai', {
      cookie: admin.cookie,
      body: { nip: gone.nip, nama: 'Duplikat', statusKepegawaian: 'PNS' },
    });
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toContain('Pulihkan dari tab Terhapus');
  });

  it('400 on pangkat family mismatch, invalid NIP and unknown keys', async () => {
    const bad = [
      { nip: uniqueNip(), nama: 'Salah Pangkat', statusKepegawaian: 'PPPK', pangkatKode: 'III/a' },
      { nip: '123', nama: 'Salah NIP', statusKepegawaian: 'PNS' },
      { nip: uniqueNip(), nama: 'Kunci Asing', statusKepegawaian: 'PNS', foo: 1 },
      { nip: uniqueNip(), nama: 'Unit Asing', statusKepegawaian: 'PNS', unitId: 99999 },
    ];
    for (const body of bad) {
      expect((await call('/api/admin/pegawai', { cookie: admin.cookie, body })).status).toBe(400);
    }
  });

  it('409 on duplicate NIK', async () => {
    const nik = uniqueNik();
    await env.DB.prepare(`UPDATE pegawai SET nik = ?1 WHERE id = ?2`).bind(nik, (await mk({ nama: 'Nik Holder' })).id).run();
    const res = await call('/api/admin/pegawai', {
      cookie: admin.cookie,
      body: { nip: uniqueNip(), nama: 'Nik Sama', statusKepegawaian: 'PNS', nik },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { fields?: Record<string, string> } };
    expect(Object.keys(body.error.fields ?? {})).toEqual(['nik']);
  });

  it('409 with a "permanent deletion pending" message once retention has expired', async () => {
    // Retention over but not yet purged: restore is impossible, so don't point to the Terhapus tab.
    const gone = await mk({ nama: `Expired ${tag()}`, deleted: { expired: true } });
    const res = await call('/api/admin/pegawai', {
      cookie: admin.cookie,
      body: { nip: gone.nip, nama: 'Duplikat', statusKepegawaian: 'PNS' },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { message: string; fields?: Record<string, string> } };
    expect(Object.keys(body.error.fields ?? {})).toEqual(['nip']);
    expect(body.error.message).not.toContain('Pulihkan');
    expect(body.error.message).toContain('dihapus permanen');
  });
});

describe('PATCH audit', () => {
  const patch = (id: number, body: unknown) =>
    call(`/api/admin/pegawai/${id}`, { method: 'PATCH', cookie: admin.cookie, body });
  const auditRows = (id: number) =>
    env.DB.prepare(`SELECT description FROM log_aktivitas WHERE action = 'PEGAWAI_UPDATE' AND target_id = ?1`)
      .bind(String(id))
      .all<{ description: string | null }>()
      .then((r) => r.results);

  it('writes no audit row when the update is refused as stale', async () => {
    const f = await mk({ nama: `AuditStale ${tag()}` });
    const res = await patch(f.id, { jabatan: 'X', expectedUpdatedAt: '2000-01-01T00:00:00.000Z' });
    expect(res.status).toBe(409);
    expect(await auditRows(f.id)).toHaveLength(0);
  });

  it('logs field names but never NIK, phone or email values', async () => {
    const f = await mk({ nama: `AuditPii ${tag()}` });
    const nik = uniqueNik();
    const res = await patch(f.id, { nik, noHp: '081234567899', email: 'rahasia@contoh.go.id' });
    expect(res.status).toBe(200);
    const rows = await auditRows(f.id);
    expect(rows).toHaveLength(1);
    const text = rows[0]?.description ?? '';
    expect(text).toContain('nik');
    for (const secret of [nik, '081234567899', '6281234567899', 'rahasia@contoh.go.id']) {
      expect(text).not.toContain(secret);
    }
  });
});

describe('PATCH /api/admin/pegawai/:id', () => {
  const patch = (id: number, body: unknown, cookie = admin.cookie) =>
    call(`/api/admin/pegawai/${id}`, { method: 'PATCH', cookie, body });

  it('updates employment and personal fields directly', async () => {
    const f = await mk({ nama: `Edit ${tag()}` });
    const res = await patch(f.id, { pangkatKode: 'III/b', jabatan: 'Analis', unitId: 2, nama: 'Nama Baru', agama: 'Islam' });
    expect(res.status).toBe(200);
    const body = await json<PegawaiDetailResponse>(res);
    expect(body.pegawai).toMatchObject({ pangkatKode: 'III/b', jabatan: 'Analis', unitId: 2, nama: 'Nama Baru', agama: 'Islam' });
    const audit = await env.DB.prepare(
      `SELECT description FROM log_aktivitas WHERE action = 'PEGAWAI_UPDATE' AND target_id = ?1`,
    )
      .bind(String(f.id))
      .first<{ description: string }>();
    expect(audit!.description).toContain('pangkatKode');
    expect(audit!.description).not.toContain('Nama Baru');
  });

  it('validates pangkat against the effective status', async () => {
    const f = await mk({ nama: `Eff ${tag()}` });
    expect((await patch(f.id, { pangkatKode: 'III/a' })).status).toBe(200);
    // Switching to PPPK while keeping a PNS pangkat.
    expect((await patch(f.id, { statusKepegawaian: 'PPPK' })).status).toBe(400);
    expect((await patch(f.id, { statusKepegawaian: 'PPPK', pangkatKode: 'PPPK-I' })).status).toBe(200);
    expect((await patch(f.id, { pangkatKode: 'II/a' })).status).toBe(400);
  });

  it('rejects NIP, unknown keys and an empty body', async () => {
    const f = await mk({ nama: `Strict ${tag()}` });
    expect((await patch(f.id, { nip: uniqueNip() })).status).toBe(400);
    expect((await patch(f.id, { isAdmin: true })).status).toBe(400);
    expect((await patch(f.id, {})).status).toBe(400);
  });

  it('403 when an admin changes their own role', async () => {
    const res = await patch(admin.user.id, { role: 'Pegawai' });
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).toContain('peran akun sendiri');
  });

  it('409 when demoting the last active admin', async () => {
    const target = await mk({ nama: `LastAdmin ${tag()}`, akun: { isDefault: 0 } });
    await env.DB.prepare(`UPDATE pegawai SET role = 'Admin' WHERE id = ?1`).bind(target.id).run();
    const { results: others } = await env.DB.prepare(
      `SELECT id FROM pegawai WHERE role = 'Admin' AND status_akun = 'Aktif' AND deleted_at IS NULL AND id <> ?1`,
    )
      .bind(target.id)
      .all<{ id: number }>();
    await env.DB.prepare(`UPDATE pegawai SET status_akun = 'Nonaktif' WHERE role = 'Admin' AND id <> ?1`)
      .bind(target.id)
      .run();
    try {
      // Unreachable over HTTP (the caller is itself an active admin): call the service directly
      // with an actor that no longer counts as an active admin.
      const auth = {
        user: { ...{ id: 0, nip: uniqueNip(), nama: 'Ex Admin' }, role: 'Admin' as const, statusKepegawaian: null, jabatan: null, fotoR2Key: null, isDefaultPassword: false },
        tokenHash: 'x',
      };
      await expect(
        updatePegawai(env, auth, String(target.id), { role: 'Pegawai' }, { ip: null, userAgent: null, nowMs: Date.now() }),
      ).rejects.toMatchObject({ status: 409, message: 'Harus ada minimal satu Admin aktif.' });
    } finally {
      for (const o of others) {
        await env.DB.prepare(`UPDATE pegawai SET status_akun = 'Aktif' WHERE id = ?1`).bind(o.id).run();
      }
    }
    const row = await env.DB.prepare(`SELECT role FROM pegawai WHERE id = ?1`).bind(target.id).first<{ role: string }>();
    expect(row!.role).toBe('Admin');
  });

  it('409 on a stale expectedUpdatedAt; succeeds with the current one', async () => {
    const f = await mk({ nama: `Stale ${tag()}` });
    const cur = await json<PegawaiDetailResponse>(await call(`/api/admin/pegawai/${f.id}`, { cookie: admin.cookie }));
    const stale = await patch(f.id, { jabatan: 'A', expectedUpdatedAt: '2000-01-01T00:00:00.000Z' });
    expect(stale.status).toBe(409);
    const staleBody = (await stale.json()) as { error: { message: string; fields?: Record<string, string> } };
    expect(staleBody.error.message).toContain('Muat ulang');
    expect(Object.keys(staleBody.error.fields ?? {})).toEqual(['stale']);
    const ok = await patch(f.id, { jabatan: 'A', expectedUpdatedAt: cur.pegawai.updatedAt });
    expect(ok.status).toBe(200);
  });

  it('a role change revokes the target sessions', async () => {
    const target = await person();
    expect((await call('/api/auth/me', { cookie: target.cookie })).status).toBe(200);
    const res = await patch(target.user.id, { role: 'Admin' });
    expect(res.status).toBe(200);
    expect((await json<PegawaiDetailResponse>(res)).akun.sesiAktif).toBe(0);
    expect((await call('/api/auth/me', { cookie: target.cookie })).status).toBe(401);
  });

  it('409 on duplicate NIK; 404 for a soft-deleted target', async () => {
    const holder = await mk({ nama: `Holder ${tag()}` });
    const nik = uniqueNik();
    await env.DB.prepare(`UPDATE pegawai SET nik = ?1 WHERE id = ?2`).bind(nik, holder.id).run();
    const f = await mk({ nama: `Other ${tag()}` });
    expect((await patch(f.id, { nik })).status).toBe(409);

    const gone = await mk({ nama: `Gone ${tag()}`, deleted: {} });
    expect((await patch(gone.id, { jabatan: 'X' })).status).toBe(404);
  });
});
