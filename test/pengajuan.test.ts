import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type {
  AdminPengajuanListResponse,
  PengajuanListResponse,
  PengajuanResponse,
  ProfileResponse,
} from '../shared/profile';
import { call, createUser, json, login } from './helpers';

interface ErrBody {
  error: { code: string; message: string; fields?: Record<string, string> };
}

const ALASAN = 'SK kenaikan jabatan terbaru sudah terbit.';

async function pegawai(setup?: string) {
  const user = await createUser();
  if (setup) await env.DB.prepare(`UPDATE pegawai SET ${setup} WHERE id = ?1`).bind(user.id).run();
  const cookie = await login(user);
  return { user, cookie };
}

async function admin() {
  const user = await createUser({ role: 'Admin' });
  const cookie = await login(user);
  return { user, cookie };
}

function create(cookie: string, perubahan: Record<string, unknown>, alasan = ALASAN) {
  return call('/api/me/pengajuan', { cookie, body: { perubahan, alasan } });
}

async function createOk(cookie: string, perubahan: Record<string, unknown>) {
  const res = await create(cookie, perubahan);
  expect(res.status).toBe(201);
  return (await json<PengajuanResponse>(res)).pengajuan;
}

function pegawaiRow(id: number) {
  return env.DB.prepare(`SELECT status_kepegawaian, pangkat_kode, jabatan, unit_id FROM pegawai WHERE id = ?1`)
    .bind(id)
    .first<{ status_kepegawaian: string | null; pangkat_kode: string | null; jabatan: string | null; unit_id: number | null }>();
}

describe('POST /api/me/pengajuan', () => {
  it('creates a request storing lama/baru for changed fields only', async () => {
    const { user, cookie } = await pegawai();
    const res = await create(cookie, { jabatan: 'Analis Pajak', statusKepegawaian: 'PNS', unitId: 1 });
    expect(res.status).toBe(201);
    const { pengajuan } = await json<PengajuanResponse>(res);
    expect(pengajuan.status).toBe('Menunggu');
    expect(pengajuan.pegawaiId).toBe(user.id);
    expect(pengajuan.perubahan).toEqual({
      jabatan: { lama: 'Penguji', baru: 'Analis Pajak' },
      unitId: { lama: null, baru: 1 },
    });

    const row = await env.DB.prepare(`SELECT perubahan, alasan, status FROM pengajuan_perubahan WHERE id = ?1`)
      .bind(pengajuan.id)
      .first<{ perubahan: string; alasan: string; status: string }>();
    expect(JSON.parse(row!.perubahan)).toEqual(pengajuan.perubahan);
    expect(row!.alasan).toBe(ALASAN);

    const log = await env.DB.prepare(
      `SELECT description FROM log_aktivitas WHERE actor_id = ?1 AND action = 'PENGAJUAN_CREATE'`,
    )
      .bind(user.id)
      .first<{ description: string }>();
    expect(log?.description).toContain('jabatan');
    expect(log?.description).not.toContain('Analis');
  });

  it('rejects a second pending request with 409', async () => {
    const { cookie } = await pegawai();
    await createOk(cookie, { jabatan: 'Analis' });
    const res = await create(cookie, { jabatan: 'Lainnya' });
    expect(res.status).toBe(409);
    expect((await json<ErrBody>(res)).error.code).toBe('CONFLICT');
  });

  it('rejects a request with no actual change', async () => {
    const { cookie } = await pegawai();
    const res = await create(cookie, { jabatan: 'Penguji', statusKepegawaian: 'PNS' });
    expect(res.status).toBe(400);
    expect((await json<ErrBody>(res)).error.fields?._form).toBe('Tidak ada data yang berubah.');
  });

  it('rejects a PPPK pangkat for a PNS employee', async () => {
    const { cookie } = await pegawai();
    const res = await create(cookie, { pangkatKode: 'PPPK-IX' });
    expect(res.status).toBe(400);
    expect((await json<ErrBody>(res)).error.fields?.['perubahan.pangkatKode']).toBe(
      'Pangkat/golongan tidak sesuai dengan status kepegawaian.',
    );
  });

  it('rejects an unknown pangkat', async () => {
    const { cookie } = await pegawai();
    const res = await create(cookie, { pangkatKode: 'X/z' });
    expect(res.status).toBe(400);
    expect((await json<ErrBody>(res)).error.fields?.['perubahan.pangkatKode']).toBeTruthy();
  });

  it('requires a fitting pangkat when the status family changes', async () => {
    const { cookie } = await pegawai(`pangkat_kode = 'III/a'`);
    let res = await create(cookie, { statusKepegawaian: 'PPPK' });
    expect(res.status).toBe(400);
    expect((await json<ErrBody>(res)).error.fields?.['perubahan.pangkatKode']).toBe(
      'Pilih pangkat/golongan yang sesuai status baru.',
    );
    res = await create(cookie, { statusKepegawaian: 'PPPK', pangkatKode: 'PPPK-IX' });
    expect(res.status).toBe(201);
  });

  it('allows PNS → CPNS without a new pangkat (same family)', async () => {
    const { cookie } = await pegawai(`pangkat_kode = 'III/a'`);
    expect((await create(cookie, { statusKepegawaian: 'CPNS' })).status).toBe(201);
  });

  it('rejects an unknown unit', async () => {
    const { cookie } = await pegawai();
    const res = await create(cookie, { unitId: 999999 });
    expect(res.status).toBe(400);
    expect((await json<ErrBody>(res)).error.fields?.['perubahan.unitId']).toBe('Unit organisasi tidak valid.');
  });

  it('rejects unknown keys inside perubahan with a readable message', async () => {
    const { cookie } = await pegawai();
    const res = await create(cookie, { nik: '1234567890123456' });
    expect(res.status).toBe(400);
    expect((await json<ErrBody>(res)).error.fields?.perubahan).toMatch(/data kepegawaian/);
  });

  it('rejects a short alasan', async () => {
    const { cookie } = await pegawai();
    const res = await create(cookie, { jabatan: 'Analis' }, 'pendek');
    expect(res.status).toBe(400);
    expect((await json<ErrBody>(res)).error.fields?.alasan).toBeTruthy();
  });
});

describe('own pengajuan list and cancel', () => {
  it('lists own requests newest first', async () => {
    const { cookie } = await pegawai();
    const first = await createOk(cookie, { jabatan: 'A1' });
    expect((await call(`/api/me/pengajuan/${first.id}`, { method: 'DELETE', cookie })).status).toBe(200);
    const second = await createOk(cookie, { jabatan: 'A2' });
    const res = await call('/api/me/pengajuan', { cookie });
    expect(res.status).toBe(200);
    const { items } = await json<PengajuanListResponse>(res);
    expect(items.map((i) => i.id)).toEqual([second.id, first.id]);
    expect(items[1]?.status).toBe('Dibatalkan');
  });

  it('cancels, refuses a second cancel, and hides other users requests', async () => {
    const a = await pegawai();
    const b = await pegawai();
    const p = await createOk(a.cookie, { jabatan: 'Analis' });

    expect((await call(`/api/me/pengajuan/${p.id}`, { method: 'DELETE', cookie: b.cookie })).status).toBe(404);

    const res = await call(`/api/me/pengajuan/${p.id}`, { method: 'DELETE', cookie: a.cookie });
    expect(res.status).toBe(200);
    expect((await json<PengajuanResponse>(res)).pengajuan.status).toBe('Dibatalkan');

    const again = await call(`/api/me/pengajuan/${p.id}`, { method: 'DELETE', cookie: a.cookie });
    expect(again.status).toBe(409);

    const log = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM log_aktivitas WHERE action = 'PENGAJUAN_CANCEL' AND target_id = ?1`,
    )
      .bind(String(p.id))
      .first<{ n: number }>();
    expect(log?.n).toBe(1);
    expect((await call('/api/me/pengajuan/abc', { method: 'DELETE', cookie: a.cookie })).status).toBe(404);
  });
});

describe('admin pengajuan', () => {
  it('lists pending requests with counts and refuses non-admins', async () => {
    const p = await pegawai();
    const created = await createOk(p.cookie, { jabatan: 'Analis' });
    const adm = await admin();

    const res = await call('/api/admin/pengajuan', { cookie: adm.cookie });
    expect(res.status).toBe(200);
    const body = await json<AdminPengajuanListResponse>(res);
    expect(Object.keys(body.counts).sort()).toEqual(['Dibatalkan', 'Disetujui', 'Ditolak', 'Menunggu']);
    expect(body.counts.Menunggu).toBeGreaterThanOrEqual(1);
    expect(body.items.every((i) => i.status === 'Menunggu')).toBe(true);
    const item = body.items.find((i) => i.id === created.id);
    expect(item?.pegawai).toMatchObject({ id: p.user.id, nip: p.user.nip, statusKepegawaian: 'PNS' });
    expect(item?.stale).toBe(false);

    expect((await call('/api/admin/pengajuan', { cookie: p.cookie })).status).toBe(403);
    expect((await call('/api/admin/pengajuan?status=Bogus', { cookie: adm.cookie })).status).toBe(400);
  });

  it('flags stale requests after the pegawai row changes', async () => {
    const p = await pegawai();
    const created = await createOk(p.cookie, { jabatan: 'Analis' });
    await env.DB.prepare(`UPDATE pegawai SET jabatan = 'Diubah Langsung' WHERE id = ?1`).bind(p.user.id).run();
    const adm = await admin();
    const body = await json<AdminPengajuanListResponse>(await call('/api/admin/pengajuan', { cookie: adm.cookie }));
    expect(body.items.find((i) => i.id === created.id)?.stale).toBe(true);
  });

  it('approves atomically, audits, and refuses to approve twice', async () => {
    const p = await pegawai();
    const created = await createOk(p.cookie, {
      jabatan: 'Kepala Seksi',
      statusKepegawaian: 'PPPK',
      pangkatKode: 'PPPK-IX',
    });
    const adm = await admin();
    const res = await call(`/api/admin/pengajuan/${created.id}/approve`, {
      cookie: adm.cookie,
      body: { catatan: 'Sesuai SK.' },
    });
    expect(res.status).toBe(200);
    const { pengajuan } = await json<PengajuanResponse>(res);
    expect(pengajuan.status).toBe('Disetujui');
    expect(pengajuan.catatanAdmin).toBe('Sesuai SK.');
    expect(pengajuan.reviewedBy?.id).toBe(adm.user.id);

    expect(await pegawaiRow(p.user.id)).toMatchObject({
      jabatan: 'Kepala Seksi',
      status_kepegawaian: 'PPPK',
      pangkat_kode: 'PPPK-IX',
    });
    const log = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM log_aktivitas WHERE action = 'PENGAJUAN_APPROVE' AND target_id = ?1`,
    )
      .bind(String(created.id))
      .first<{ n: number }>();
    expect(log?.n).toBe(1);

    const again = await call(`/api/admin/pengajuan/${created.id}/approve`, { cookie: adm.cookie, body: {} });
    expect(again.status).toBe(409);

    // Profile reflects the change and a new request can be filed.
    const profile = await json<ProfileResponse>(await call('/api/me/profile', { cookie: p.cookie }));
    expect(profile.profile.jabatan).toBe('Kepala Seksi');
    expect(profile.pengajuanAktif).toBeNull();
    expect((await create(p.cookie, { jabatan: 'Kepala Seksi Baru' })).status).toBe(201);
  });

  it('approves without a body', async () => {
    const p = await pegawai();
    const created = await createOk(p.cookie, { jabatan: 'Analis' });
    const adm = await admin();
    const res = await call(`/api/admin/pengajuan/${created.id}/approve`, { method: 'POST', cookie: adm.cookie });
    expect(res.status).toBe(200);
  });

  it('refuses to approve a cancelled request', async () => {
    const p = await pegawai();
    const created = await createOk(p.cookie, { jabatan: 'Analis' });
    await call(`/api/me/pengajuan/${created.id}`, { method: 'DELETE', cookie: p.cookie });
    const adm = await admin();
    const res = await call(`/api/admin/pengajuan/${created.id}/approve`, { cookie: adm.cookie, body: {} });
    expect(res.status).toBe(409);
    expect((await pegawaiRow(p.user.id))?.jabatan).toBe('Penguji');
  });

  it('refuses an admin approving their own request (four-eyes)', async () => {
    const adm = await admin();
    const created = await createOk(adm.cookie, { jabatan: 'Kepala' });
    const res = await call(`/api/admin/pengajuan/${created.id}/approve`, { cookie: adm.cookie, body: {} });
    expect(res.status).toBe(403);
    expect((await json<ErrBody>(res)).error.message).toBe('Pengajuan Anda sendiri harus diverifikasi admin lain.');
    const rej = await call(`/api/admin/pengajuan/${created.id}/reject`, {
      cookie: adm.cookie,
      body: { catatan: 'Tolak sendiri' },
    });
    expect(rej.status).toBe(403);
  });

  it('returns 404 for an unknown request', async () => {
    const adm = await admin();
    expect((await call('/api/admin/pengajuan/99999999/approve', { cookie: adm.cookie, body: {} })).status).toBe(404);
  });

  it('rejects with a note and leaves the pegawai unchanged', async () => {
    const p = await pegawai();
    const created = await createOk(p.cookie, { jabatan: 'Analis' });
    const adm = await admin();

    let res = await call(`/api/admin/pengajuan/${created.id}/reject`, { cookie: adm.cookie, body: {} });
    expect(res.status).toBe(400);
    expect((await json<ErrBody>(res)).error.fields?.catatan).toBeTruthy();

    res = await call(`/api/admin/pengajuan/${created.id}/reject`, {
      cookie: adm.cookie,
      body: { catatan: 'SK belum dilampirkan.' },
    });
    expect(res.status).toBe(200);
    const { pengajuan } = await json<PengajuanResponse>(res);
    expect(pengajuan.status).toBe('Ditolak');
    expect(pengajuan.catatanAdmin).toBe('SK belum dilampirkan.');
    expect((await pegawaiRow(p.user.id))?.jabatan).toBe('Penguji');

    const log = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM log_aktivitas WHERE action = 'PENGAJUAN_REJECT' AND target_id = ?1`,
    )
      .bind(String(created.id))
      .first<{ n: number }>();
    expect(log?.n).toBe(1);

    const again = await call(`/api/admin/pengajuan/${created.id}/reject`, {
      cookie: adm.cookie,
      body: { catatan: 'Tolak lagi.' },
    });
    expect(again.status).toBe(409);
  });
});

describe('review fixes (pengajuan)', () => {
  async function insertPending(pegawaiId: number, perubahan: unknown) {
    const row = await env.DB.prepare(
      `INSERT INTO pengajuan_perubahan (pegawai_id, perubahan, alasan, status, created_at)
       VALUES (?1, ?2, 'Disisipkan langsung', 'Menunggu', ?3) RETURNING id`,
    )
      .bind(pegawaiId, JSON.stringify(perubahan), new Date().toISOString())
      .first<{ id: number }>();
    return row!.id;
  }

  it('ignores non-whitelisted keys injected into the stored JSON', async () => {
    const p = await pegawai();
    const pid = await insertPending(p.user.id, {
      role: { lama: 'Pegawai', baru: 'Admin' },
      nip: { lama: 'x', baru: '999999999999999999' },
      jabatan: { lama: null, baru: 'Baru' },
    });
    const adm = await admin();
    const res = await call(`/api/admin/pengajuan/${pid}/approve`, { cookie: adm.cookie, body: {} });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare(`SELECT role, nip, jabatan FROM pegawai WHERE id = ?1`)
      .bind(p.user.id)
      .first<{ role: string; nip: string; jabatan: string }>();
    expect(row).toEqual({ role: 'Pegawai', nip: p.user.nip, jabatan: 'Baru' });
  });

  it('refuses approve and reject from a Pegawai', async () => {
    const p = await pegawai();
    const created = await createOk(p.cookie, { jabatan: 'Analis' });
    const other = await pegawai();
    expect((await call(`/api/admin/pengajuan/${created.id}/approve`, { cookie: other.cookie, body: {} })).status).toBe(
      403,
    );
    expect(
      (await call(`/api/admin/pengajuan/${created.id}/reject`, { cookie: other.cookie, body: { catatan: 'Tidak boleh' } }))
        .status,
    ).toBe(403);
    expect((await pegawaiRow(p.user.id))?.jabatan).toBe('Penguji');
  });

  it('refuses to approve for a soft-deleted pegawai', async () => {
    const p = await pegawai();
    const created = await createOk(p.cookie, { jabatan: 'Analis' });
    const now = new Date().toISOString();
    await env.DB.prepare(`UPDATE pegawai SET deleted_at = ?2, purge_after = ?2 WHERE id = ?1`)
      .bind(p.user.id, now)
      .run();
    const adm = await admin();
    const res = await call(`/api/admin/pengajuan/${created.id}/approve`, { cookie: adm.cookie, body: {} });
    expect(res.status).toBe(409);
    expect((await pegawaiRow(p.user.id))?.jabatan).toBe('Penguji');
  });

  it('re-validates pangkat against the current status on approve', async () => {
    const p = await pegawai();
    const created = await createOk(p.cookie, { pangkatKode: 'III/b', jabatan: 'Analis' });
    await env.DB.prepare(`UPDATE pegawai SET status_kepegawaian = 'PPPK' WHERE id = ?1`).bind(p.user.id).run();
    const adm = await admin();
    const res = await call(`/api/admin/pengajuan/${created.id}/approve`, { cookie: adm.cookie, body: {} });
    expect(res.status).toBe(409);
    expect((await json<ErrBody>(res)).error.message).toMatch(/tidak lagi sesuai/);
    expect(await pegawaiRow(p.user.id)).toMatchObject({ pangkat_kode: null, jabatan: 'Penguji' });
    const status = await env.DB.prepare(`SELECT status FROM pengajuan_perubahan WHERE id = ?1`)
      .bind(created.id)
      .first<{ status: string }>();
    expect(status?.status).toBe('Menunggu');
  });

  it('refuses to approve when a referenced unit was deactivated', async () => {
    const unit = await env.DB.prepare(
      `INSERT INTO ref_unit_organisasi (nama, aktif) VALUES (?1, 1) RETURNING id`,
    )
      .bind(`Unit Uji ${Math.random()}`)
      .first<{ id: number }>();
    const p = await pegawai();
    const created = await createOk(p.cookie, { unitId: unit!.id });
    await env.DB.prepare(`UPDATE ref_unit_organisasi SET aktif = 0 WHERE id = ?1`).bind(unit!.id).run();
    const adm = await admin();
    const res = await call(`/api/admin/pengajuan/${created.id}/approve`, { cookie: adm.cookie, body: {} });
    expect(res.status).toBe(409);
    expect((await pegawaiRow(p.user.id))?.unit_id).toBeNull();
  });

  it('records reviewed_at on cancel and keeps reviewed_by null', async () => {
    const p = await pegawai();
    const created = await createOk(p.cookie, { jabatan: 'Analis' });
    const res = await call(`/api/me/pengajuan/${created.id}`, { method: 'DELETE', cookie: p.cookie });
    const { pengajuan } = await json<PengajuanResponse>(res);
    expect(pengajuan.reviewedAt).toBeTruthy();
    expect(pengajuan.reviewedBy).toBeNull();
  });

  it('rejects pengajuan mutations without a same-site Origin', async () => {
    const p = await pegawai();
    const created = await createOk(p.cookie, { jabatan: 'Analis' });
    const adm = await admin();
    for (const origin of [null, 'https://evil.example']) {
      const del = await call(`/api/me/pengajuan/${created.id}`, { method: 'DELETE', cookie: p.cookie, origin });
      expect(del.status).toBe(403);
      expect((await json<ErrBody>(del)).error.code).toBe('CSRF_REJECTED');
      const approve = await call(`/api/admin/pengajuan/${created.id}/approve`, {
        cookie: adm.cookie,
        origin,
        body: {},
      });
      expect(approve.status).toBe(403);
      expect((await json<ErrBody>(approve)).error.code).toBe('CSRF_REJECTED');
    }
    expect((await pegawaiRow(p.user.id))?.jabatan).toBe('Penguji');
  });
});
