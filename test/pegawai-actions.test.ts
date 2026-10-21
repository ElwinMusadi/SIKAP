// Phase 6 Part B: account actions, soft delete / restore, admin dashboard.
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type {
  AccountActionResponse,
  AdminDashboardResponse,
  DeletePegawaiResponse,
  PegawaiListResponse,
} from '../shared/pegawai';
import type { VerifikasiQueueResponse } from '../shared/verifikasi';
import type { AuthContext } from '../server/env';
import { setStatusAkun, softDelete } from '../server/services/pegawai';
import { selectAdminRecipients } from '../server/services/notifikasi';
import { call, createUser, json, login, uniqueNip } from './helpers';
import { ensureJenis, insertArsip, person } from './phase5-helpers';

let admin: Awaited<ReturnType<typeof person>>;

beforeAll(async () => {
  admin = await person({ role: 'Admin' });
});

let nikSeq = 0;
/** Unique, valid 16-digit NIK. */
function uniqueNik(prefix: string): string {
  nikSeq += 1;
  return `${prefix}${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}${String(nikSeq).padStart(8, '0')}`;
}

const post = (path: string, body?: unknown, cookie = admin.cookie) =>
  call(`/api/admin/pegawai/${path}`, { method: 'POST', cookie, body });
const del = (id: number, cookie = admin.cookie) => call(`/api/admin/pegawai/${id}`, { method: 'DELETE', cookie });

async function errorOf(res: Response): Promise<{ code: string; message: string }> {
  return (await json<{ error: { code: string; message: string } }>(res)).error;
}

async function loginStatus(nip: string, password: string): Promise<{ status: number; code: string | null }> {
  const res = await call('/api/auth/login', { body: { nip, password } });
  if (res.status === 200) return { status: 200, code: null };
  return { status: res.status, code: (await errorOf(res)).code };
}

async function insertPending(pegawaiId: number): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO pengajuan_perubahan (pegawai_id, perubahan, alasan, status, created_at)
     VALUES (?1, '{"jabatan":{"lama":"A","baru":"B"}}', 'Alasan pengujian', 'Menunggu', ?2) RETURNING id`,
  )
    .bind(pegawaiId, new Date().toISOString())
    .first<{ id: number }>();
  return row!.id;
}

/** Service-level actor that is NOT itself an active admin in the DB (id 0). */
function ghostAdmin(): AuthContext {
  return {
    user: {
      id: 0,
      nip: uniqueNip(),
      nama: 'Ex Admin',
      role: 'Admin',
      statusKepegawaian: null,
      jabatan: null,
      fotoR2Key: null,
      isDefaultPassword: false,
    },
    tokenHash: 'x',
  };
}

describe('CSRF', () => {
  it('rejects POST status without Origin', async () => {
    const target = await person();
    const res = await call(`/api/admin/pegawai/${target.user.id}/status`, {
      method: 'POST',
      cookie: admin.cookie,
      body: { statusAkun: 'Nonaktif' },
      origin: null,
    });
    expect(res.status).toBe(403);
    expect((await call('/api/auth/me', { cookie: target.cookie })).status).toBe(200);
  });
});

describe('access control', () => {
  it('rejects a Pegawai on every Part B route', async () => {
    const p = await person();
    const id = admin.user.id;
    const responses = await Promise.all([
      post(`${id}/status`, { statusAkun: 'Nonaktif' }, p.cookie),
      post(`${id}/reset-password`, undefined, p.cookie),
      post(`${id}/unlock`, undefined, p.cookie),
      del(id, p.cookie),
      post(`${id}/restore`, undefined, p.cookie),
      call('/api/admin/dashboard', { cookie: p.cookie }),
    ]);
    expect(responses.map((r) => r.status)).toEqual([403, 403, 403, 403, 403, 403]);
  });
});

describe('POST /api/admin/pegawai/:id/status', () => {
  it('deactivates (revoking sessions), is idempotent, and reactivates', async () => {
    const target = await person();
    const res = await post(`${target.user.id}/status`, { statusAkun: 'Nonaktif' });
    expect(res.status).toBe(200);
    const body = await json<AccountActionResponse>(res);
    expect(body.item.statusAkun).toBe('Nonaktif');
    expect(body.revokedSessions).toBe(1);
    expect((await call('/api/auth/me', { cookie: target.cookie })).status).toBe(401);
    expect(await loginStatus(target.user.nip, target.user.password)).toEqual({ status: 403, code: 'ACCOUNT_INACTIVE' });

    // Same state again: 200, no second audit row.
    const again = await post(`${target.user.id}/status`, { statusAkun: 'Nonaktif' });
    expect(again.status).toBe(200);
    const audits = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM log_aktivitas WHERE action = 'PEGAWAI_DEACTIVATE' AND target_id = ?1`,
    )
      .bind(String(target.user.id))
      .first<{ n: number }>();
    expect(audits!.n).toBe(1);

    const back = await post(`${target.user.id}/status`, { statusAkun: 'Aktif' });
    expect(back.status).toBe(200);
    expect((await json<AccountActionResponse>(back)).item.statusAkun).toBe('Aktif');
    expect((await loginStatus(target.user.nip, target.user.password)).status).toBe(200);
  });

  it('403 on self-deactivation, 400 on a bad body, 404 on unknown/deleted', async () => {
    const self = await post(`${admin.user.id}/status`, { statusAkun: 'Nonaktif' });
    expect(self.status).toBe(403);
    expect((await errorOf(self)).message).toBe('Anda tidak dapat menonaktifkan akun sendiri.');
    expect((await post(`${admin.user.id}/status`, { statusAkun: 'Libur' })).status).toBe(400);
    expect((await post('999999999/status', { statusAkun: 'Nonaktif' })).status).toBe(404);
    const gone = await createUser({ deleted: true });
    expect((await post(`${gone.id}/status`, { statusAkun: 'Aktif' })).status).toBe(404);
  });

  it('409 when deactivating or deleting the last active admin (atomic SQL guard)', async () => {
    // Unreachable over HTTP (the caller is itself an active admin): call the services with an
    // actor that is not an active admin in the DB, after deactivating every other admin.
    const target = await createUser({ role: 'Admin' });
    const { results: others } = await env.DB.prepare(
      `SELECT id FROM pegawai WHERE role = 'Admin' AND status_akun = 'Aktif' AND deleted_at IS NULL AND id <> ?1`,
    )
      .bind(target.id)
      .all<{ id: number }>();
    await env.DB.prepare(`UPDATE pegawai SET status_akun = 'Nonaktif' WHERE role = 'Admin' AND id <> ?1`)
      .bind(target.id)
      .run();
    const meta = { ip: null, userAgent: null, nowMs: Date.now() };
    try {
      await expect(
        setStatusAkun(env, ghostAdmin(), String(target.id), { statusAkun: 'Nonaktif' }, meta),
      ).rejects.toMatchObject({ status: 409, message: 'Harus ada minimal satu Admin aktif.' });
      await expect(softDelete(env, ghostAdmin(), String(target.id), meta)).rejects.toMatchObject({
        status: 409,
        message: 'Harus ada minimal satu Admin aktif.',
      });
    } finally {
      for (const o of others) {
        await env.DB.prepare(`UPDATE pegawai SET status_akun = 'Aktif' WHERE id = ?1`).bind(o.id).run();
      }
    }
    const row = await env.DB.prepare(`SELECT status_akun, deleted_at FROM pegawai WHERE id = ?1`)
      .bind(target.id)
      .first<{ status_akun: string; deleted_at: string | null }>();
    expect(row).toEqual({ status_akun: 'Aktif', deleted_at: null });
  });
});

describe('POST /api/admin/pegawai/:id/reset-password', () => {
  it('resets to the default password, clears the lock and revokes sessions', async () => {
    const custom = 'RahasiaBaru#2026';
    const target = await createUser({ password: custom });
    const cookie = await login(target);
    await env.DB.prepare(`UPDATE akun SET failed_attempts = 3 WHERE pegawai_id = ?1`).bind(target.id).run();

    const res = await post(`${target.id}/reset-password`);
    expect(res.status).toBe(200);
    const body = await json<AccountActionResponse>(res);
    expect(body.revokedSessions).toBe(1);
    expect(body.item.isDefaultPassword).toBe(true);
    expect((await call('/api/auth/me', { cookie })).status).toBe(401);

    const akun = await env.DB.prepare(
      `SELECT failed_attempts, locked_until, password_changed_at, is_default_password FROM akun WHERE pegawai_id = ?1`,
    )
      .bind(target.id)
      .first<{ failed_attempts: number; locked_until: string | null; password_changed_at: string | null; is_default_password: number }>();
    expect(akun).toMatchObject({ failed_attempts: 0, locked_until: null, is_default_password: 1 });
    expect(akun!.password_changed_at).not.toBeNull();

    expect((await loginStatus(target.nip, custom)).status).toBe(401);
    const fresh = await login({ ...target, password: target.nip.slice(-6) });
    const me = await call('/api/auth/me', { cookie: fresh });
    expect(JSON.stringify(await me.json())).toContain('"isDefaultPassword":true');

    const audit = await env.DB.prepare(
      `SELECT description FROM log_aktivitas WHERE action = 'PASSWORD_RESET' AND target_id = ?1`,
    )
      .bind(String(target.id))
      .first<{ description: string }>();
    expect(audit!.description).not.toContain(target.nip.slice(-6));
  });

  it('403 for self, 404 for deleted', async () => {
    const self = await post(`${admin.user.id}/reset-password`);
    expect(self.status).toBe(403);
    expect((await errorOf(self)).message).toBe('Gunakan Pengaturan Akun untuk mengganti password Anda.');
    const gone = await createUser({ deleted: true });
    expect((await post(`${gone.id}/reset-password`)).status).toBe(404);
  });
});

describe('POST /api/admin/pegawai/:id/unlock', () => {
  it('unlocks an account locked by failed logins', async () => {
    const target = await createUser();
    for (let i = 0; i < 5; i++) await call('/api/auth/login', { body: { nip: target.nip, password: 'salah-salah' } });
    expect((await loginStatus(target.nip, target.password)).code).toBe('ACCOUNT_LOCKED');

    const res = await post(`${target.id}/unlock`);
    expect(res.status).toBe(200);
    const body = await json<AccountActionResponse>(res);
    expect(body).toMatchObject({ revokedSessions: 0, item: { terkunci: false } });
    expect((await loginStatus(target.nip, target.password)).status).toBe(200);

    // Nothing left to clear: 200 without a second audit row.
    expect((await post(`${target.id}/unlock`)).status).toBe(200);
    const audits = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM log_aktivitas WHERE action = 'ACCOUNT_UNLOCK' AND target_id = ?1`,
    )
      .bind(String(target.id))
      .first<{ n: number }>();
    expect(audits!.n).toBe(1);
  });
});

describe('DELETE /api/admin/pegawai/:id and restore', () => {
  it('soft-deletes: sessions, login, pengajuan, list, queue, recipients; files untouched', async () => {
    const jenis = `DOC-T6-${Math.random().toString(36).slice(2, 8)}`;
    await ensureJenis(jenis);
    const target = await person({ role: 'Admin' });
    const pengajuanId = await insertPending(target.user.id);
    const arsipId = await insertArsip(target.user.id, jenis);
    const arsip = await env.DB.prepare(`SELECT r2_key FROM arsip_dokumen WHERE id = ?1`).bind(arsipId).first<{ r2_key: string }>();
    await env.FILES.put(arsip!.r2_key, new Uint8Array([1, 2, 3]));

    const queueBefore = await json<VerifikasiQueueResponse>(
      await call(`/api/admin/verifikasi?jenis=${jenis}`, { cookie: admin.cookie }),
    );
    expect(queueBefore.items.map((i) => i.arsipId)).toContain(arsipId);
    const recipientsBefore = (await selectAdminRecipients(env.DB, 0).all<{ id: number }>()).results.map((r) => r.id);
    expect(recipientsBefore).toContain(target.user.id);

    const before = Date.now();
    const res = await del(target.user.id);
    expect(res.status).toBe(200);
    const { purgeAfter } = await json<DeletePegawaiResponse>(res);
    const expected = before + 7 * 86_400_000;
    expect(Math.abs(Date.parse(purgeAfter) - expected)).toBeLessThan(60_000);

    expect((await call('/api/auth/me', { cookie: target.cookie })).status).toBe(401);
    expect(await loginStatus(target.user.nip, target.user.password)).toEqual({ status: 401, code: 'INVALID_CREDENTIALS' });

    const q = await env.DB.prepare(`SELECT status, reviewed_at FROM pengajuan_perubahan WHERE id = ?1`)
      .bind(pengajuanId)
      .first<{ status: string; reviewed_at: string | null }>();
    expect(q!.status).toBe('Dibatalkan');
    expect(q!.reviewed_at).not.toBeNull();

    const nipQ = target.user.nip;
    const live = await json<PegawaiListResponse>(await call(`/api/admin/pegawai?q=${nipQ}`, { cookie: admin.cookie }));
    expect(live.items).toHaveLength(0);
    const trash = await json<PegawaiListResponse>(
      await call(`/api/admin/pegawai?q=${nipQ}&terhapus=true`, { cookie: admin.cookie }),
    );
    expect(trash.items.map((i) => i.id)).toEqual([target.user.id]);
    expect(trash.items[0]!.deleted).toMatchObject({ purgeAfter, deletedBy: { id: admin.user.id } });

    const queueAfter = await json<VerifikasiQueueResponse>(
      await call(`/api/admin/verifikasi?jenis=${jenis}`, { cookie: admin.cookie }),
    );
    expect(queueAfter.items.map((i) => i.arsipId)).not.toContain(arsipId);
    const recipientsAfter = (await selectAdminRecipients(env.DB, 0).all<{ id: number }>()).results.map((r) => r.id);
    expect(recipientsAfter).not.toContain(target.user.id);

    const still = await env.DB.prepare(`SELECT deleted_at FROM arsip_dokumen WHERE id = ?1`).bind(arsipId).first<{ deleted_at: string | null }>();
    expect(still).toMatchObject({ deleted_at: null });
    expect(await env.FILES.head(arsip!.r2_key)).not.toBeNull();

    expect((await call(`/api/admin/pegawai/${target.user.id}`, { cookie: admin.cookie })).status).toBe(404);
    expect((await del(target.user.id)).status).toBe(404);
  });

  it('403 for self-delete; 404 for unknown', async () => {
    const self = await del(admin.user.id);
    expect(self.status).toBe(403);
    expect((await del(999999999)).status).toBe(404);
    expect((await call('/api/admin/pegawai/abc', { method: 'DELETE', cookie: admin.cookie })).status).toBe(404);
  });

  it('restores within retention with the same password', async () => {
    const custom = 'PasswordTetap#77';
    const target = await createUser({ password: custom });
    expect((await del(target.id)).status).toBe(200);

    const res = await post(`${target.id}/restore`);
    expect(res.status).toBe(200);
    const body = await json<AccountActionResponse>(res);
    expect(body).toMatchObject({ revokedSessions: 0, item: { id: target.id, deleted: null, statusAkun: 'Aktif' } });

    const live = await json<PegawaiListResponse>(await call(`/api/admin/pegawai?q=${target.nip}`, { cookie: admin.cookie }));
    expect(live.items.map((i) => i.id)).toEqual([target.id]);
    expect((await loginStatus(target.nip, custom)).status).toBe(200);
    // Not deleted any more: a second restore is a 404.
    expect((await post(`${target.id}/restore`)).status).toBe(404);
  });

  it('404 after retention ended', async () => {
    const target = await createUser();
    expect((await del(target.id)).status).toBe(200);
    await env.DB.prepare(`UPDATE pegawai SET purge_after = ?2 WHERE id = ?1`)
      .bind(target.id, new Date(Date.now() - 1000).toISOString())
      .run();
    expect((await post(`${target.id}/restore`)).status).toBe(404);
  });

  it('NIK stays reserved while soft-deleted, so restore never collides', async () => {
    // UNIQUE(nik) also covers soft-deleted rows: nobody can take a deleted employee's NIK, so
    // the restore NIK conflict (409) cannot arise under the current schema. The pre-check and
    // the UPDATE guard remain as defence in depth should that constraint ever become partial.
    const target = await createUser();
    const nik = uniqueNik('52');
    await env.DB.prepare(`UPDATE pegawai SET nik = ?2 WHERE id = ?1`).bind(target.id, nik).run();
    expect((await del(target.id)).status).toBe(200);

    const taker = await call('/api/admin/pegawai', {
      cookie: admin.cookie,
      body: { nip: uniqueNip(), nama: 'Pengambil NIK', statusKepegawaian: 'PNS', nik },
    });
    expect(taker.status).toBe(409);

    const res = await post(`${target.id}/restore`);
    expect(res.status).toBe(200);
  });
});

describe('GET /api/admin/dashboard', () => {
  const get = async () => {
    const res = await call('/api/admin/dashboard', { cookie: admin.cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toContain('no-store');
    return json<AdminDashboardResponse>(res);
  };

  it('counts match fresh fixtures (deltas)', async () => {
    const extra = `DOC-T6D-${Math.random().toString(36).slice(2, 8)}`;
    await ensureJenis(extra);
    const before = await get();

    // PPPK, default password, all mandatory docs verified + one extra pending doc.
    const pppk = await createUser();
    await env.DB.prepare(`UPDATE pegawai SET status_kepegawaian = 'PPPK' WHERE id = ?1`).bind(pppk.id).run();
    const { results: wajib } = await env.DB.prepare(
      `SELECT w.jenis_dokumen_id AS id FROM jenis_dokumen_wajib w JOIN jenis_dokumen j ON j.id = w.jenis_dokumen_id AND j.aktif = 1
        WHERE w.status_kepegawaian = 'PPPK'`,
    ).all<{ id: string }>();
    for (const w of wajib) await insertArsip(pppk.id, w.id, { status: 'Terverifikasi' });
    await insertArsip(pppk.id, extra, { status: 'Menunggu' });
    await insertPending(pppk.id);
    // No status, custom password.
    const kosong = await createUser({ password: 'BukanDefault#1' });
    await env.DB.prepare(`UPDATE pegawai SET status_kepegawaian = NULL WHERE id = ?1`).bind(kosong.id).run();
    // Nonaktif: counted in pegawai totals, excluded from completeness.
    await createUser({ statusAkun: 'Nonaktif' });
    // Deleted: excluded everywhere.
    await createUser({ deleted: true });

    const after = await get();
    expect(after.pegawai.total - before.pegawai.total).toBe(3);
    expect(after.pegawai.aktif - before.pegawai.aktif).toBe(2);
    expect(after.pegawai.nonaktif - before.pegawai.nonaktif).toBe(1);
    expect(after.pegawai.perStatus.PPPK - before.pegawai.perStatus.PPPK).toBe(1);
    expect(after.pegawai.perStatus['Belum diisi'] - before.pegawai.perStatus['Belum diisi']).toBe(1);
    expect(after.pegawai.perStatus.PNS - before.pegawai.perStatus.PNS).toBe(1);
    expect(after.pegawai.passwordDefault - before.pegawai.passwordDefault).toBe(2);
    expect(after.dokumen.menunggu - before.dokumen.menunggu).toBe(1);
    expect(after.dokumen.perKelengkapan.Lengkap - before.dokumen.perKelengkapan.Lengkap).toBe(1);
    expect(after.dokumen.perKelengkapan['Belum Lengkap'] - before.dokumen.perKelengkapan['Belum Lengkap']).toBe(1);
    expect(after.pengajuanMenunggu - before.pengajuanMenunggu).toBe(1);
    expect(after.dokumen.persenKelengkapan).toBeGreaterThanOrEqual(0);
    expect(after.dokumen.persenKelengkapan).toBeLessThanOrEqual(100);
  });

  it('lists at most 7 latest activities without PII', async () => {
    const nip = uniqueNip();
    const nik = uniqueNik('53');
    const created = await call('/api/admin/pegawai', {
      cookie: admin.cookie,
      body: { nip, nama: 'Dashboard Uji', statusKepegawaian: 'PNS', nik },
    });
    expect(created.status).toBe(201);
    const d = await get();
    expect(d.aktivitasTerbaru.length).toBeGreaterThan(0);
    expect(d.aktivitasTerbaru.length).toBeLessThanOrEqual(7);
    // Other test files may log concurrently (shared DB): presence, not position.
    expect(d.aktivitasTerbaru.some((a) => a.action === 'PEGAWAI_CREATE')).toBe(true);
    const tsList = d.aktivitasTerbaru.map((a) => a.ts);
    expect([...tsList].sort().reverse()).toEqual(tsList);
    const text = JSON.stringify(d.aktivitasTerbaru);
    expect(text).not.toContain(nik);
    expect(text).not.toContain(nip);
    expect(Object.keys(d.aktivitasTerbaru[0]!).sort()).toEqual(['action', 'actorNama', 'description', 'id', 'result', 'ts']);
  });
});
