import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DecisionResponse, VerifikasiQueueResponse } from '../shared/verifikasi';
import { clearDeferredTasks } from '../server/services/notifikasi';
import { call, json } from './helpers';
import { ensureJenis, insertArsip, insertPegawai, person, setNotif } from './phase5-helpers';

let jenisSeq = 0;
async function freshJenis(): Promise<string> {
  jenisSeq += 1;
  const id = `DOC-T5-${Date.now().toString(36)}-${jenisSeq}`;
  await ensureJenis(id, `Dokumen Uji ${jenisSeq}`);
  return id;
}

async function queue(cookie: string, qs = ''): Promise<Response> {
  return call(`/api/admin/verifikasi${qs}`, { cookie });
}

async function arsip(id: number) {
  return env.DB.prepare(`SELECT * FROM arsip_dokumen WHERE id = ?1`).bind(id).first<Record<string, unknown>>();
}

async function outboxFor(target: string) {
  return (
    await env.DB.prepare(`SELECT * FROM notifikasi_outbox WHERE target = ?1 ORDER BY id`).bind(target).all<Record<string, unknown>>()
  ).results;
}

beforeEach(() => clearDeferredTasks());
afterEach(async () => {
  vi.restoreAllMocks();
  await setNotif({ dokumenBaru: true, dokumenApproved: true, dokumenRejected: true });
});

describe('GET /api/admin/verifikasi', () => {
  it('lists only active Menunggu items of live pegawai, oldest first, with counts', async () => {
    const admin = await person({ role: 'Admin' });
    const jenis = await freshJenis();
    const p1 = await insertPegawai();
    const p2 = await insertPegawai();
    const p3 = await insertPegawai();
    const gone = await insertPegawai({ deleted: true });
    const newer = await insertArsip(p1, jenis, { uploadedAt: '2026-01-02T00:00:00.000Z' });
    const older = await insertArsip(p2, jenis, { uploadedAt: '2026-01-01T00:00:00.000Z' });
    await insertArsip(p3, jenis, { status: 'Terverifikasi' });
    await insertArsip(gone, jenis);
    const p4 = await insertPegawai();
    await insertArsip(p4, jenis, { deleted: true });

    const res = await queue(admin.cookie, `?jenis=${jenis}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = await json<VerifikasiQueueResponse>(res);
    expect(body.items.map((i) => i.arsipId)).toEqual([older, newer]);
    expect(body.perJenis[jenis]).toBe(2);
    expect(body.total).toBeGreaterThanOrEqual(2);
    expect(body.nextCursor).toBeNull();
    const item = body.items[0]!;
    expect(item.jenisDokumen.id).toBe(jenis);
    expect(item.pegawai.id).toBe(p2);
    expect(item.isReupload).toBe(false);
    expect(item.catatanSebelumnya).toBeNull();
    expect(item.file).toEqual({ fileName: 'f.pdf', mimeType: 'application/pdf', sizeBytes: 10 });
  });

  it('jenis filter excludes other types; total ignores the filter', async () => {
    const admin = await person({ role: 'Admin' });
    const a = await freshJenis();
    const b = await freshJenis();
    await insertArsip(await insertPegawai(), a);
    await insertArsip(await insertPegawai(), b);
    const body = await json<VerifikasiQueueResponse>(await queue(admin.cookie, `?jenis=${a}`));
    expect(body.items.every((i) => i.jenisDokumen.id === a)).toBe(true);
    expect(body.perJenis[a]).toBe(1);
    expect(body.perJenis[b]).toBe(1);
    const sum = Object.values(body.perJenis).reduce((s, n) => s + n, 0);
    expect(body.total).toBe(sum);
  });

  it('pages with a keyset cursor (> 25 items)', async () => {
    const admin = await person({ role: 'Admin' });
    const jenis = await freshJenis();
    const ids: number[] = [];
    const base = Date.parse('2025-06-01T00:00:00.000Z');
    for (let i = 0; i < 30; i++) {
      // Two items share each timestamp to exercise the id tie-break.
      const at = new Date(base + Math.floor(i / 2) * 1000).toISOString();
      ids.push(await insertArsip(await insertPegawai(), jenis, { uploadedAt: at }));
    }
    const p1 = await json<VerifikasiQueueResponse>(await queue(admin.cookie, `?jenis=${jenis}`));
    expect(p1.items).toHaveLength(25);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = await json<VerifikasiQueueResponse>(
      await queue(admin.cookie, `?jenis=${jenis}&cursor=${encodeURIComponent(p1.nextCursor!)}`),
    );
    expect(p2.items).toHaveLength(5);
    expect(p2.nextCursor).toBeNull();
    expect([...p1.items, ...p2.items].map((i) => i.arsipId)).toEqual(ids);
  });

  it('rejects an invalid cursor with 400', async () => {
    const admin = await person({ role: 'Admin' });
    for (const c of ['%%%', 'bm90LWEtY3Vyc29y', btoa('2026-01-01T00:00:00.000Z|0')]) {
      const res = await queue(admin.cookie, `?cursor=${encodeURIComponent(c)}`);
      expect(res.status).toBe(400);
    }
  });

  it('shows the previous rejection note on a re-upload', async () => {
    const admin = await person({ role: 'Admin' });
    const jenis = await freshJenis();
    const pid = await insertPegawai();
    const id = await insertArsip(pid, jenis, { versi: 2 });
    await env.DB.prepare(
      `INSERT INTO arsip_dokumen_riwayat (arsip_id, pegawai_id, jenis_dokumen_id, versi, aksi, status, catatan, actor_id, created_at)
       VALUES (?1, ?2, ?3, 1, 'REJECT', 'Ditolak', 'Scan buram', NULL, '2025-01-01T00:00:00.000Z')`,
    )
      .bind(id, pid, jenis)
      .run();
    const body = await json<VerifikasiQueueResponse>(await queue(admin.cookie, `?jenis=${jenis}`));
    expect(body.items[0]).toMatchObject({ arsipId: id, isReupload: true, catatanSebelumnya: 'Scan buram' });
  });

  it('is admin only', async () => {
    const p = await person();
    expect((await queue(p.cookie)).status).toBe(403);
    expect((await queue('')).status).toBe(401);
  });
});

describe('POST /api/admin/verifikasi/:id/approve|reject', () => {
  async function setup(opts: { phone?: string | null } = {}) {
    const admin = await person({ role: 'Admin' });
    const owner = await person({ phone: opts.phone });
    const jenis = await freshJenis();
    const id = await insertArsip(owner.user.id, jenis);
    return { admin, owner, jenis, id };
  }

  it('approves: status, verifier, riwayat, audit, outbox, sisaAntrean', async () => {
    const { admin, owner, jenis, id } = await setup();
    const res = await call(`/api/admin/verifikasi/${id}/approve`, { cookie: admin.cookie, body: { versi: 1 } });
    expect(res.status).toBe(200);
    const body = await json<DecisionResponse>(res);
    expect(body).toMatchObject({ arsipId: id, status: 'Terverifikasi', notifikasi: 'DIANTRIKAN' });
    expect(typeof body.sisaAntrean).toBe('number');

    const row = await arsip(id);
    expect(row).toMatchObject({ status: 'Terverifikasi', verified_by: admin.user.id, catatan_admin: null });
    expect(row?.verified_at).toBeTruthy();
    const riwayat = await env.DB.prepare(`SELECT * FROM arsip_dokumen_riwayat WHERE arsip_id = ?1`).bind(id).all();
    expect(riwayat.results).toHaveLength(1);
    expect(riwayat.results[0]).toMatchObject({ aksi: 'APPROVE', status: 'Terverifikasi', pegawai_id: owner.user.id, jenis_dokumen_id: jenis });
    const audit = await env.DB.prepare(`SELECT * FROM log_aktivitas WHERE action = 'DOKUMEN_APPROVE' AND target_id = ?1`)
      .bind(String(id))
      .all();
    expect(audit.results).toHaveLength(1);
    const ob = await outboxFor(owner.phone!);
    expect(ob).toHaveLength(1);
    expect(ob[0]).toMatchObject({ template: 'dokumen_terverifikasi', status: 'PENDING', attempts: 0 });
    expect(JSON.parse(ob[0]!.params as string)).toEqual({ nama: `Pegawai Uji ${owner.user.id}`, namaDokumen: expect.any(String) });

    const again = await call(`/api/admin/verifikasi/${id}/approve`, { cookie: admin.cookie, body: { versi: 1 } });
    expect(again.status).toBe(409);
    expect((await json<{ error: { message: string } }>(again)).error.message).toBe('Dokumen telah berubah. Muat ulang antrean.');
    expect(await outboxFor(owner.phone!)).toHaveLength(1);
  });

  it('stale versi (owner re-uploaded) is 409 and changes nothing', async () => {
    const { admin, owner, id } = await setup();
    await env.DB.prepare(`UPDATE arsip_dokumen SET versi = 2 WHERE id = ?1`).bind(id).run();
    const res = await call(`/api/admin/verifikasi/${id}/approve`, { cookie: admin.cookie, body: { versi: 1 } });
    expect(res.status).toBe(409);
    expect((await arsip(id))?.status).toBe('Menunggu');
    expect(await outboxFor(owner.phone!)).toHaveLength(0);
    const riwayat = await env.DB.prepare(`SELECT COUNT(*) AS n FROM arsip_dokumen_riwayat WHERE arsip_id = ?1`).bind(id).first<{ n: number }>();
    expect(riwayat?.n).toBe(0);
  });

  it('the outbox guard inserts nothing when the CAS fails inside the batch', async () => {
    // Race simulation: the pre-read sees versi 1, the batch's CAS does not match.
    const { decideArsip } = await import('../server/db/verifikasi');
    const { decisionGuard, outboxStatements } = await import('../server/services/notifikasi');
    const { admin, owner, id } = await setup();
    await env.DB.prepare(`UPDATE arsip_dokumen SET versi = 3 WHERE id = ?1`).bind(id).run();
    const now = new Date().toISOString();
    const res = await env.DB.batch([
      decideArsip(env.DB, id, 1, 'Terverifikasi', admin.user.id, now, null),
      ...outboxStatements(
        env.DB,
        [{ target: owner.phone!, template: 'dokumen_terverifikasi', params: { nama: 'x', namaDokumen: 'y' } }],
        decisionGuard(id, 1, 'Terverifikasi', admin.user.id, now),
        now,
      ),
    ]);
    expect(res[0]?.meta.changes).toBe(0);
    expect(await outboxFor(owner.phone!)).toHaveLength(0);
  });

  it('same-millisecond duplicate decisions: one succeeds, one 409, exactly one outbox row', async () => {
    const { approveDocument } = await import('../server/services/verifikasi');
    const { admin, owner, id } = await setup();
    const auth = {
      user: {
        id: admin.user.id,
        nip: admin.user.nip,
        nama: `Pegawai Uji ${admin.user.id}`,
        role: 'Admin' as const,
        statusKepegawaian: null,
        jabatan: null,
        fotoR2Key: null,
        isDefaultPassword: false,
      },
      tokenHash: 'test',
    };
    const meta = { ip: null, userAgent: null, nowMs: Date.now() }; // identical nowMs → identical post-condition
    const settled = await Promise.allSettled([
      approveDocument(env, auth, String(id), { versi: 1 }, meta),
      approveDocument(env, auth, String(id), { versi: 1 }, meta),
    ]);
    const ok = settled.filter((s) => s.status === 'fulfilled');
    const bad = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect(bad[0]!.reason).toMatchObject({ status: 409, code: 'CONFLICT' });
    expect((ok[0] as PromiseFulfilledResult<{ outboxIds: number[] }>).value.outboxIds).toHaveLength(1);
    expect(await outboxFor(owner.phone!)).toHaveLength(1);
    const audits = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM log_aktivitas WHERE action = 'DOKUMEN_APPROVE' AND target_id = ?1`,
    )
      .bind(String(id))
      .first<{ n: number }>();
    expect(audits?.n).toBe(1);

    // Sequential replay with the same nowMs (the race above may have serialised either way).
    await expect(approveDocument(env, auth, String(id), { versi: 1 }, meta)).rejects.toMatchObject({ status: 409 });
    expect(await outboxFor(owner.phone!)).toHaveLength(1);
  });

  it('batch-level replay: CAS no-op + gated audit no-op ⇒ decision outbox INSERT skipped', async () => {
    // Deterministic version of the race: the post-condition already holds (first decision
    // committed with the same nowIso), but this batch's CAS changes nothing.
    const { decideArsip } = await import('../server/db/verifikasi');
    const { riwayatAfterChange } = await import('../server/db/dokumen');
    const { decisionGuard, outboxStatements } = await import('../server/services/notifikasi');
    const { admin, owner, id } = await setup();
    const now = new Date().toISOString();
    await env.DB.prepare(
      `UPDATE arsip_dokumen SET status = 'Terverifikasi', verified_by = ?2, verified_at = ?3 WHERE id = ?1`,
    )
      .bind(id, admin.user.id, now)
      .run();
    const res = await env.DB.batch([
      decideArsip(env.DB, id, 1, 'Terverifikasi', admin.user.id, now, null),
      riwayatAfterChange(env.DB, 'APPROVE', null, admin.user.id, now, { arsipId: id }),
      ...outboxStatements(
        env.DB,
        [{ target: owner.phone!, template: 'dokumen_terverifikasi', params: { nama: 'x', namaDokumen: 'y' } }],
        decisionGuard(id, 1, 'Terverifikasi', admin.user.id, now),
        now,
      ),
    ]);
    expect(res[0]?.meta.changes).toBe(0);
    expect(await outboxFor(owner.phone!)).toHaveLength(0);
  });

  it('soft-deleted arsip → 404; unknown id → 404', async () => {
    const admin = await person({ role: 'Admin' });
    const jenis = await freshJenis();
    const id = await insertArsip(await insertPegawai(), jenis, { deleted: true });
    expect((await call(`/api/admin/verifikasi/${id}/approve`, { cookie: admin.cookie, body: { versi: 1 } })).status).toBe(404);
    expect((await call(`/api/admin/verifikasi/99999999/approve`, { cookie: admin.cookie, body: { versi: 1 } })).status).toBe(404);
    expect((await call(`/api/admin/verifikasi/abc/approve`, { cookie: admin.cookie, body: { versi: 1 } })).status).toBe(404);
  });

  it("own document → 403 with the four-eyes message", async () => {
    const admin = await person({ role: 'Admin' });
    const id = await insertArsip(admin.user.id, await freshJenis());
    const res = await call(`/api/admin/verifikasi/${id}/approve`, { cookie: admin.cookie, body: { versi: 1 } });
    expect(res.status).toBe(403);
    expect((await json<{ error: { message: string } }>(res)).error.message).toBe(
      'Dokumen Anda sendiri harus diverifikasi admin lain.',
    );
    expect((await arsip(id))?.status).toBe('Menunggu');
  });

  it('rejects: alasan validated, catatan_admin, outbox with alasan', async () => {
    const { admin, owner, id } = await setup();
    const short = await call(`/api/admin/verifikasi/${id}/reject`, { cookie: admin.cookie, body: { versi: 1, alasan: 'abc' } });
    expect(short.status).toBe(400);
    const missing = await call(`/api/admin/verifikasi/${id}/reject`, { cookie: admin.cookie, body: { versi: 1 } });
    expect(missing.status).toBe(400);

    const res = await call(`/api/admin/verifikasi/${id}/reject`, {
      cookie: admin.cookie,
      body: { versi: 1, alasan: '  Dokumen tidak terbaca  ' },
    });
    expect(res.status).toBe(200);
    expect(await json<DecisionResponse>(res)).toMatchObject({ status: 'Ditolak', notifikasi: 'DIANTRIKAN' });
    expect(await arsip(id)).toMatchObject({ status: 'Ditolak', catatan_admin: 'Dokumen tidak terbaca' });
    const riwayat = await env.DB.prepare(`SELECT aksi, catatan FROM arsip_dokumen_riwayat WHERE arsip_id = ?1`).bind(id).first();
    expect(riwayat).toEqual({ aksi: 'REJECT', catatan: 'Dokumen tidak terbaca' });
    const ob = await outboxFor(owner.phone!);
    expect(ob).toHaveLength(1);
    expect(ob[0]?.template).toBe('dokumen_ditolak');
    expect(JSON.parse(ob[0]!.params as string).alasan).toBe('Dokumen tidak terbaca');
  });

  it("notif disabled → NONAKTIF and no outbox row", async () => {
    await setNotif({ dokumenApproved: false });
    const { admin, owner, id } = await setup();
    const res = await call(`/api/admin/verifikasi/${id}/approve`, { cookie: admin.cookie, body: { versi: 1 } });
    expect((await json<DecisionResponse>(res)).notifikasi).toBe('NONAKTIF');
    expect(await outboxFor(owner.phone!)).toHaveLength(0);
    expect((await arsip(id))?.status).toBe('Terverifikasi');
  });

  it('pegawai without phone → TANPA_NOMOR', async () => {
    const { admin, id } = await setup({ phone: null });
    const res = await call(`/api/admin/verifikasi/${id}/reject`, { cookie: admin.cookie, body: { versi: 1, alasan: 'Kurang jelas' } });
    expect((await json<DecisionResponse>(res)).notifikasi).toBe('TANPA_NOMOR');
  });

  it('is admin only and CSRF protected', async () => {
    const { admin, owner, id } = await setup();
    expect((await call(`/api/admin/verifikasi/${id}/approve`, { cookie: owner.cookie, body: { versi: 1 } })).status).toBe(403);
    const csrf = await call(`/api/admin/verifikasi/${id}/approve`, {
      cookie: admin.cookie,
      body: { versi: 1 },
      origin: 'https://evil.example',
    });
    expect(csrf.status).toBe(403);
    expect((await arsip(id))?.status).toBe('Menunggu');
  });
});
