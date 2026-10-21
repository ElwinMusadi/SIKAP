import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { drainPurgeQueue, purgeExpired, R2_DELETE_FAILED } from '../server/services/purge';
import { getRiwayat, rollbackDocument } from '../server/services/dokumen';
import type { AuthContext } from '../server/env';
import { createUser, uniqueNip } from './helpers';

const DAY = 86_400_000;
const iso = (ms: number): string => new Date(ms).toISOString();

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM r2_purge_queue').run();
});
afterEach(() => vi.restoreAllMocks());

async function newKey(prefix = 'dokumen'): Promise<string> {
  const key = `${prefix}/${crypto.randomUUID()}.pdf`;
  await env.FILES.put(key, 'x');
  return key;
}

async function exists(key: string): Promise<boolean> {
  return (await env.FILES.head(key)) !== null;
}

async function addArsip(
  pegawaiId: number,
  jenis: string,
  opts: { deletedAt?: number; purgeAfter?: number; id?: number; key?: string } = {},
): Promise<{ id: number; key: string }> {
  const key = opts.key ?? (await newKey());
  const row = await env.DB.prepare(
    `INSERT INTO arsip_dokumen (id, pegawai_id, jenis_dokumen_id, status, r2_key, file_name, mime_type, size_bytes,
        sha256, versi, uploaded_at, deleted_at, purge_after)
     VALUES (?1, ?2, ?3, 'Menunggu', ?4, 'f.pdf', 'application/pdf', 1, 'h', 3, ?5, ?6, ?7) RETURNING id`,
  )
    .bind(
      opts.id ?? null,
      pegawaiId,
      jenis,
      key,
      iso(Date.now()),
      opts.deletedAt === undefined ? null : iso(opts.deletedAt),
      opts.purgeAfter === undefined ? null : iso(opts.purgeAfter),
    )
    .first<{ id: number }>();
  return { id: Number(row?.id), key };
}

async function addVersi(arsipId: number, versi: number, purgeAfter: number): Promise<string> {
  const key = await newKey();
  await env.DB.prepare(
    `INSERT INTO arsip_dokumen_versi (arsip_id, versi, r2_key, file_name, mime_type, size_bytes, sha256, status,
        uploaded_at, replaced_at, reason, purge_after)
     VALUES (?1, ?2, ?3, 'f.pdf', 'application/pdf', 1, 'h', 'Menunggu', ?4, ?4, 'REUPLOAD', ?5)`,
  )
    .bind(arsipId, versi, key, iso(purgeAfter - 3 * DAY), iso(purgeAfter))
    .run();
  return key;
}

async function softDeletePegawai(id: number, purgeAfter: number): Promise<void> {
  await env.DB.prepare('UPDATE pegawai SET deleted_at = ?2, purge_after = ?3 WHERE id = ?1')
    .bind(id, iso(purgeAfter - 7 * DAY), iso(purgeAfter))
    .run();
}

async function queued(key: string): Promise<boolean> {
  return (await env.DB.prepare('SELECT 1 FROM r2_purge_queue WHERE object_key = ?1').bind(key).first()) !== null;
}

const count = async (sql: string, ...binds: unknown[]): Promise<number> =>
  Number((await env.DB.prepare(sql).bind(...binds).first<{ n: number }>('n')) ?? 0);

describe('Phase 7 retention purge', () => {
  it('purges an expired version, keeps the active file, and drain removes only the version object', async () => {
    const T = Date.parse('2031-01-10T00:00:00.000Z');
    const user = await createUser();
    const arsip = await addArsip(user.id, 'DOC-KTP');
    const oldKey = await addVersi(arsip.id, 1, T - 1);

    const res = await purgeExpired(env.DB, T);
    expect(res.versions).toBeGreaterThanOrEqual(1);
    expect(await count('SELECT count(*) AS n FROM arsip_dokumen_versi WHERE arsip_id = ?1', arsip.id)).toBe(0);
    expect(await queued(oldKey)).toBe(true);
    expect(await queued(arsip.key)).toBe(false);
    expect(await exists(oldKey)).toBe(true); // D1 purge never touches R2

    const drain = await drainPurgeQueue(env, T);
    expect(drain).toMatchObject({ failed: 0, skipped: false });
    expect(drain.deleted).toBeGreaterThanOrEqual(1);
    expect(await exists(oldKey)).toBe(false);
    expect(await exists(arsip.key)).toBe(true);
    expect(await queued(oldKey)).toBe(false);
  });

  it('never deletes a referenced key that was queued artificially; the row is dropped', async () => {
    const T = Date.parse('2031-01-11T00:00:00.000Z');
    const foto = await newKey('foto');
    const user = await createUser({ fotoR2Key: foto });
    const arsip = await addArsip(user.id, 'DOC-KTP');
    const versiKey = await addVersi(arsip.id, 1, T + DAY);
    for (const key of [foto, arsip.key, versiKey]) {
      await env.DB.prepare(
        `INSERT INTO r2_purge_queue (object_key, bucket, source, enqueued_at) VALUES (?1, 'FILES', 'TEST', ?2)`,
      )
        .bind(key, iso(T))
        .run();
    }
    const del = vi.spyOn(env.FILES, 'delete');
    const drain = await drainPurgeQueue(env, T);
    expect(drain).toMatchObject({ claimed: 3, deleted: 0, referenced: 3, failed: 0 });
    expect(del).not.toHaveBeenCalled();
    for (const key of [foto, arsip.key, versiKey]) {
      expect(await exists(key)).toBe(true);
      expect(await queued(key)).toBe(false);
    }
  });

  it('keeps a soft-deleted document within retention together with its expired versions', async () => {
    const T = Date.parse('2031-01-12T00:00:00.000Z');
    const user = await createUser();
    const arsip = await addArsip(user.id, 'DOC-KTP', { deletedAt: T - DAY, purgeAfter: T + 2 * DAY });
    const versiKey = await addVersi(arsip.id, 1, T - DAY);
    await purgeExpired(env.DB, T);
    expect(await count('SELECT count(*) AS n FROM arsip_dokumen WHERE id = ?1', arsip.id)).toBe(1);
    expect(await count('SELECT count(*) AS n FROM arsip_dokumen_versi WHERE arsip_id = ?1', arsip.id)).toBe(1);
    expect(await queued(versiKey)).toBe(false);
    expect(await queued(arsip.key)).toBe(false);

    // After the document's own retention both go together.
    const later = T + 2 * DAY;
    const res = await purgeExpired(env.DB, later);
    expect(res.documents).toBeGreaterThanOrEqual(1);
    expect(await count('SELECT count(*) AS n FROM arsip_dokumen WHERE id = ?1', arsip.id)).toBe(0);
    expect(await queued(versiKey)).toBe(true);
    expect(await queued(arsip.key)).toBe(true);
  });

  it('employee within 7-day retention keeps documents and versions even when their 3 days expired', async () => {
    const T = Date.parse('2031-01-13T00:00:00.000Z');
    const foto = await newKey('foto');
    const user = await createUser({ fotoR2Key: foto });
    const active = await addArsip(user.id, 'DOC-KTP');
    const activeVersi = await addVersi(active.id, 1, T - 2 * DAY);
    const deleted = await addArsip(user.id, 'DOC-KK', { deletedAt: T - 4 * DAY, purgeAfter: T - DAY });
    const deletedVersi = await addVersi(deleted.id, 1, T - 2 * DAY);
    await env.DB.prepare(
      `INSERT INTO arsip_dokumen_riwayat (arsip_id, pegawai_id, jenis_dokumen_id, versi, aksi, created_at)
       VALUES (?1, ?2, 'DOC-KTP', 1, 'UPLOAD', ?3)`,
    )
      .bind(active.id, user.id, iso(T - 5 * DAY))
      .run();
    await softDeletePegawai(user.id, T + DAY);

    await purgeExpired(env.DB, T);
    expect(await count('SELECT count(*) AS n FROM pegawai WHERE id = ?1', user.id)).toBe(1);
    expect(await count('SELECT count(*) AS n FROM arsip_dokumen WHERE pegawai_id = ?1', user.id)).toBe(2);
    expect(
      await count('SELECT count(*) AS n FROM arsip_dokumen_versi WHERE arsip_id IN (?1, ?2)', active.id, deleted.id),
    ).toBe(2);
    for (const key of [foto, active.key, activeVersi, deleted.key, deletedVersi]) expect(await queued(key)).toBe(false);

    // Expired employee: one guarded transaction captures every key and cascades.
    const later = T + DAY;
    const res = await purgeExpired(env.DB, later);
    expect(res.employees).toBeGreaterThanOrEqual(1);
    expect(await count('SELECT count(*) AS n FROM pegawai WHERE id = ?1', user.id)).toBe(0);
    expect(await count('SELECT count(*) AS n FROM akun WHERE pegawai_id = ?1', user.id)).toBe(0);
    expect(await count('SELECT count(*) AS n FROM arsip_dokumen WHERE pegawai_id = ?1', user.id)).toBe(0);
    expect(
      await count('SELECT count(*) AS n FROM arsip_dokumen_versi WHERE arsip_id IN (?1, ?2)', active.id, deleted.id),
    ).toBe(0);
    expect(await count('SELECT count(*) AS n FROM arsip_dokumen_riwayat WHERE pegawai_id = ?1', user.id)).toBe(0);
    for (const key of [foto, active.key, activeVersi, deleted.key, deletedVersi]) expect(await queued(key)).toBe(true);

    await drainPurgeQueue(env, later);
    for (const key of [foto, active.key, activeVersi, deleted.key, deletedVersi]) expect(await exists(key)).toBe(false);
  });

  it('a reused numeric pegawai/arsip id never inherits history and its new UUID file is untouched', async () => {
    const T = Date.parse('2031-01-14T00:00:00.000Z');
    const user = await createUser();
    const old = await addArsip(user.id, 'DOC-KTP');
    await env.DB.prepare(
      `INSERT INTO arsip_dokumen_riwayat (arsip_id, pegawai_id, jenis_dokumen_id, versi, aksi, created_at)
       VALUES (?1, ?2, 'DOC-KTP', 1, 'UPLOAD', ?3)`,
    )
      .bind(old.id, user.id, iso(T - 9 * DAY))
      .run();
    await softDeletePegawai(user.id, T);
    await purgeExpired(env.DB, T);
    expect(await count('SELECT count(*) AS n FROM pegawai WHERE id = ?1', user.id)).toBe(0);

    // Same numeric ids handed out again, same jenis, fresh UUID key.
    await env.DB.prepare(`INSERT INTO pegawai (id, nip, nama) VALUES (?1, ?2, 'Pegawai Baru')`)
      .bind(user.id, uniqueNip())
      .run();
    const fresh = await addArsip(user.id, 'DOC-KTP', { id: old.id });
    const history = await env.DB.prepare(
      `SELECT count(*) AS n FROM arsip_dokumen_riwayat r JOIN arsip_dokumen a
          ON a.id = r.arsip_id AND a.pegawai_id = r.pegawai_id AND a.jenis_dokumen_id = r.jenis_dokumen_id
        WHERE r.arsip_id = ?1`,
    )
      .bind(fresh.id)
      .first<{ n: number }>('n');
    expect(history).toBe(0);

    await drainPurgeQueue(env, T);
    expect(await exists(old.key)).toBe(false);
    expect(await exists(fresh.key)).toBe(true);
  });

  it('nulls purged actors across other employees, preserves retained actors, and rollback survives ID reuse', async () => {
    const T = Date.parse('2031-02-01T00:00:00.000Z');
    const actor = await createUser({ role: 'Admin' });
    const retained = await createUser({ role: 'Admin' });
    const owner = await createUser();
    const deleted = await createUser();
    const retainedDeleted = await createUser();
    const arsip = await addArsip(owner.id, 'DOC-KTP');
    const mixed = await addArsip(owner.id, 'DOC-KK');
    const oldKey = await addVersi(arsip.id, 1, T + DAY);
    await addVersi(arsip.id, 2, T + DAY);
    await addVersi(mixed.id, 1, T + DAY);
    await addVersi(mixed.id, 2, T + DAY);
    await env.DB.batch([
      env.DB.prepare('UPDATE arsip_dokumen_versi SET uploaded_by = ?2, verified_by = ?2 WHERE arsip_id = ?1 AND versi = 1')
        .bind(arsip.id, actor.id),
      env.DB.prepare('UPDATE arsip_dokumen_versi SET uploaded_by = ?2, verified_by = ?2 WHERE arsip_id = ?1 AND versi = 2')
        .bind(arsip.id, retained.id),
      env.DB.prepare('UPDATE arsip_dokumen_versi SET uploaded_by = ?2, verified_by = ?3 WHERE arsip_id = ?1 AND versi = 1')
        .bind(mixed.id, actor.id, retained.id),
      env.DB.prepare('UPDATE arsip_dokumen_versi SET uploaded_by = ?2, verified_by = ?3 WHERE arsip_id = ?1 AND versi = 2')
        .bind(mixed.id, retained.id, actor.id),
      ...[actor.id, retained.id].map((actorId) => env.DB.prepare(
        `INSERT INTO arsip_dokumen_riwayat (arsip_id, pegawai_id, jenis_dokumen_id, versi, aksi, actor_id, created_at)
         VALUES (?1, ?2, 'DOC-KTP', 1, 'UPLOAD', ?3, ?4)`,
      ).bind(arsip.id, owner.id, actorId, iso(T - DAY))),
      env.DB.prepare(`INSERT INTO log_aktivitas (ts, actor_id, actor_nip, actor_nama, action, result)
        VALUES (?1, ?2, ?3, 'Historical admin', 'PURGE_SNAPSHOT_TEST', 'SUCCESS')`)
        .bind(iso(T), actor.id, actor.nip),
    ]);
    await softDeletePegawai(actor.id, T);
    await softDeletePegawai(retained.id, T + DAY);
    await softDeletePegawai(deleted.id, T + DAY);
    await softDeletePegawai(retainedDeleted.id, T + DAY);
    await env.DB.prepare('UPDATE pegawai SET deleted_by = ?2 WHERE id = ?1').bind(deleted.id, actor.id).run();
    await env.DB.prepare('UPDATE pegawai SET deleted_by = ?2 WHERE id = ?1').bind(retainedDeleted.id, retained.id).run();

    const result = await purgeExpired(env.DB, T, { versions: 0, documents: 0 });
    expect(result.employees).toBe(1);
    const snapshots = await env.DB.prepare(
      'SELECT arsip_id, versi, uploaded_by, verified_by FROM arsip_dokumen_versi WHERE arsip_id IN (?1, ?2) ORDER BY arsip_id, versi',
    ).bind(arsip.id, mixed.id).all();
    expect(snapshots.results).toEqual([
      { arsip_id: arsip.id, versi: 1, uploaded_by: null, verified_by: null },
      { arsip_id: arsip.id, versi: 2, uploaded_by: retained.id, verified_by: retained.id },
      { arsip_id: mixed.id, versi: 1, uploaded_by: null, verified_by: retained.id },
      { arsip_id: mixed.id, versi: 2, uploaded_by: retained.id, verified_by: null },
    ]);
    expect(await env.DB.prepare('SELECT deleted_by FROM pegawai WHERE id = ?1').bind(deleted.id).first())
      .toEqual({ deleted_by: null });
    expect(await env.DB.prepare('SELECT deleted_by FROM pegawai WHERE id = ?1').bind(retainedDeleted.id).first())
      .toEqual({ deleted_by: retained.id });

    const auth: AuthContext = {
      tokenHash: 'test',
      user: { id: owner.id, nip: owner.nip, nama: 'Owner', role: 'Pegawai', statusKepegawaian: 'PNS',
        jabatan: null, fotoR2Key: null, isDefaultPassword: false },
    };
    const meta = { nowMs: T, ip: null, userAgent: null };
    // No actor row exists: rollback must not violate arsip's uploaded_by/verified_by FKs.
    await rollbackDocument(env, auth, String(arsip.id), { versi: 1 }, meta);
    expect(await env.DB.prepare('SELECT r2_key, uploaded_by, verified_by FROM arsip_dokumen WHERE id = ?1')
      .bind(arsip.id).first()).toEqual({ r2_key: oldKey, uploaded_by: null, verified_by: null });

    await env.DB.prepare(`INSERT INTO pegawai (id, nip, nama) VALUES (?1, ?2, 'Reused actor ID')`)
      .bind(actor.id, uniqueNip()).run();
    await rollbackDocument(env, auth, String(mixed.id), { versi: 1 }, meta);
    expect(await env.DB.prepare('SELECT uploaded_by, verified_by FROM arsip_dokumen WHERE id = ?1')
      .bind(mixed.id).first()).toEqual({ uploaded_by: null, verified_by: retained.id });
    await rollbackDocument(env, auth, String(mixed.id), { versi: 2 }, meta);
    expect(await env.DB.prepare('SELECT uploaded_by, verified_by FROM arsip_dokumen WHERE id = ?1')
      .bind(mixed.id).first()).toEqual({ uploaded_by: retained.id, verified_by: null });
    expect(await env.DB.prepare('SELECT uploaded_by, verified_by FROM arsip_dokumen WHERE id = ?1')
      .bind(arsip.id).first()).toEqual({ uploaded_by: null, verified_by: null });
    const history = (await getRiwayat(env, auth, String(arsip.id))).filter((r) => r.aksi === 'UPLOAD');
    expect(history.map((r) => r.actor?.id ?? null).sort()).toEqual([null, retained.id].sort());
    expect(JSON.stringify(history)).not.toContain('Reused actor ID');
    expect(await env.DB.prepare(`SELECT actor_id, actor_nip, actor_nama FROM log_aktivitas
      WHERE action = 'PURGE_SNAPSHOT_TEST' AND actor_id = ?1`).bind(actor.id).first())
      .toEqual({ actor_id: actor.id, actor_nip: actor.nip, actor_nama: 'Historical admin' });
  });

  it('rechecks the employee expiry guard before clearing actor references when a restore wins', async () => {
    const T = Date.parse('2001-02-02T00:00:00.000Z');
    const actor = await createUser({ role: 'Admin' });
    const owner = await createUser();
    const arsip = await addArsip(owner.id, 'DOC-KTP');
    await addVersi(arsip.id, 1, T + DAY);
    await env.DB.prepare('UPDATE arsip_dokumen_versi SET uploaded_by = ?2, verified_by = ?2 WHERE arsip_id = ?1')
      .bind(arsip.id, actor.id).run();
    await env.DB.prepare(`INSERT INTO arsip_dokumen_riwayat
      (arsip_id, pegawai_id, jenis_dokumen_id, versi, aksi, actor_id, created_at)
      VALUES (?1, ?2, 'DOC-KTP', 1, 'UPLOAD', ?3, ?4)`)
      .bind(arsip.id, owner.id, actor.id, iso(T)).run();
    await softDeletePegawai(owner.id, T + DAY);
    await env.DB.prepare('UPDATE pegawai SET deleted_by = ?2 WHERE id = ?1').bind(owner.id, actor.id).run();
    await softDeletePegawai(actor.id, T);
    const batch = env.DB.batch.bind(env.DB);
    let calls = 0;
    vi.spyOn(env.DB, 'batch').mockImplementation(async (stmts) => {
      calls += 1;
      if (calls === 2) await env.DB.prepare('UPDATE pegawai SET deleted_at = NULL, purge_after = NULL WHERE id = ?1')
        .bind(actor.id).run();
      return batch(stmts);
    });
    const result = await purgeExpired(env.DB, T, { versions: 0, documents: 0 });
    expect(result.employees).toBe(0);
    expect(await env.DB.prepare('SELECT uploaded_by, verified_by FROM arsip_dokumen_versi WHERE arsip_id = ?1')
      .bind(arsip.id).first()).toEqual({ uploaded_by: actor.id, verified_by: actor.id });
    expect(await env.DB.prepare('SELECT actor_id FROM arsip_dokumen_riwayat WHERE arsip_id = ?1')
      .bind(arsip.id).first()).toEqual({ actor_id: actor.id });
    expect(await env.DB.prepare('SELECT deleted_by FROM pegawai WHERE id = ?1').bind(owner.id).first())
      .toEqual({ deleted_by: actor.id });
  });

  it('honours the expiry boundary (purge_after = now purges, now + 1 ms keeps)', async () => {
    const T = Date.parse('2031-01-15T00:00:00.000Z');
    const user = await createUser();
    const atBoundary = await addArsip(user.id, 'DOC-KTP', { deletedAt: T - 3 * DAY, purgeAfter: T });
    const justAfter = await addArsip(user.id, 'DOC-KK', { deletedAt: T - 3 * DAY, purgeAfter: T + 1 });
    const arsip = await addArsip(user.id, 'DOC-NPWP');
    const vAt = await addVersi(arsip.id, 1, T);
    const vAfter = await addVersi(arsip.id, 2, T + 1);
    await purgeExpired(env.DB, T);
    expect(await count('SELECT count(*) AS n FROM arsip_dokumen WHERE id = ?1', atBoundary.id)).toBe(0);
    expect(await count('SELECT count(*) AS n FROM arsip_dokumen WHERE id = ?1', justAfter.id)).toBe(1);
    expect(await queued(vAt)).toBe(true);
    expect(await queued(vAfter)).toBe(false);
    expect(await count('SELECT count(*) AS n FROM arsip_dokumen_versi WHERE arsip_id = ?1', arsip.id)).toBe(1);
  });

  it('a restore committed before the purge batch wins: nothing enqueued or deleted', async () => {
    const T = Date.parse('2031-01-16T00:00:00.000Z');
    const user = await createUser();
    const arsip = await addArsip(user.id, 'DOC-KTP', { deletedAt: T - 3 * DAY, purgeAfter: T });
    // Simulate the race: candidate read happened, then a restore commits before the write batch.
    const batch = env.DB.batch.bind(env.DB);
    let calls = 0;
    vi.spyOn(env.DB, 'batch').mockImplementation(async (stmts) => {
      calls += 1;
      if (calls === 2) {
        await env.DB.prepare('UPDATE arsip_dokumen SET deleted_at = NULL, purge_after = NULL WHERE id = ?1')
          .bind(arsip.id)
          .run();
      }
      return batch(stmts);
    });
    await purgeExpired(env.DB, T);
    expect(await count('SELECT count(*) AS n FROM arsip_dokumen WHERE id = ?1', arsip.id)).toBe(1);
    expect(await queued(arsip.key)).toBe(false);
  });

  it('R2 failure keeps the row queued with backoff and a safe error, then retries', async () => {
    const T = Date.parse('2031-01-17T00:00:00.000Z');
    const user = await createUser();
    const arsip = await addArsip(user.id, 'DOC-KTP');
    const key = await addVersi(arsip.id, 1, T);
    await purgeExpired(env.DB, T);
    vi.spyOn(env.FILES, 'delete').mockRejectedValueOnce(new Error('private r2 detail'));

    const failed = await drainPurgeQueue(env, T);
    expect(failed.deleted).toBe(0);
    expect(failed.failed).toBeGreaterThanOrEqual(1);
    const row = await env.DB.prepare(
      'SELECT attempts, lease_token, next_attempt_at, last_error FROM r2_purge_queue WHERE object_key = ?1',
    )
      .bind(key)
      .first<{ attempts: number; lease_token: string | null; next_attempt_at: string; last_error: string }>();
    expect(row).toMatchObject({ attempts: 1, lease_token: null, last_error: R2_DELETE_FAILED });
    expect(Date.parse(String(row?.next_attempt_at))).toBe(T + 60_000);
    expect(await exists(key)).toBe(true);

    expect((await drainPurgeQueue(env, T + 30_000)).claimed).toBe(0); // backoff respected
    const retry = await drainPurgeQueue(env, T + 60_000);
    expect(retry.failed).toBe(0);
    expect(retry.deleted).toBeGreaterThanOrEqual(1);
    expect(await exists(key)).toBe(false);
    expect(await queued(key)).toBe(false);
  });

  it('concurrent drains claim disjoint leases; a live lease is never reclaimed', async () => {
    const T = Date.parse('2031-01-18T00:00:00.000Z');
    const keys = await Promise.all(Array.from({ length: 6 }, () => newKey('orphan')));
    for (const key of keys) {
      await env.DB.prepare(
        `INSERT INTO r2_purge_queue (object_key, bucket, source, enqueued_at) VALUES (?1, 'FILES', 'TEST', ?2)`,
      )
        .bind(key, iso(T))
        .run();
    }
    const leasedKey = await newKey('orphan');
    await env.DB.prepare(
      `INSERT INTO r2_purge_queue (object_key, bucket, source, enqueued_at, lease_token, lease_until)
       VALUES (?1, 'FILES', 'TEST', ?2, 'other', ?3)`,
    )
      .bind(leasedKey, iso(T), iso(T + 60_000))
      .run();
    const backupKey = `backup/${crypto.randomUUID()}`;
    await env.DB.prepare(
      `INSERT INTO r2_purge_queue (object_key, bucket, source, enqueued_at) VALUES (?1, 'BACKUPS', 'BACKUP_EXPIRED', ?2)`,
    )
      .bind(backupKey, iso(T))
      .run();

    const deleted: string[] = [];
    const real = env.FILES.delete.bind(env.FILES);
    vi.spyOn(env.FILES, 'delete').mockImplementation(async (k) => {
      deleted.push(...(Array.isArray(k) ? k : [k]));
      return real(k);
    });
    const [a, b] = await Promise.all([drainPurgeQueue(env, T, 4), drainPurgeQueue(env, T, 4)]);
    expect(a.claimed + b.claimed).toBe(6);
    expect(new Set(deleted).size).toBe(deleted.length);
    expect(deleted.sort()).toEqual([...keys].sort());
    expect(await queued(leasedKey)).toBe(true);
    expect(await exists(leasedKey)).toBe(true);
    expect(await queued(backupKey)).toBe(true); // BACKUPS rows belong to the backup job
  });

  it('writes a SYSTEM audit row with summary counts only', async () => {
    const T = Date.parse('2031-01-19T00:00:00.000Z');
    const user = await createUser();
    const arsip = await addArsip(user.id, 'DOC-KTP', { deletedAt: T - 3 * DAY, purgeAfter: T });
    await addVersi(arsip.id, 1, T);
    const res = await purgeExpired(env.DB, T);
    const log = await env.DB.prepare(
      `SELECT actor_id, actor_nip, actor_nama, actor_role, target_id, description, result, ip
         FROM log_aktivitas WHERE action = 'RETENTION_PURGE' AND ts = ?1`,
    )
      .bind(iso(T))
      .first<Record<string, unknown>>();
    expect(log).toMatchObject({ actor_id: null, actor_nip: null, actor_nama: 'SYSTEM', target_id: null, ip: null });
    expect(JSON.parse(String(log?.description))).toEqual({
      versions: res.versions,
      documents: res.documents,
      employees: res.employees,
    });
    const text = JSON.stringify(log);
    expect(text).not.toContain(user.nip);
    expect(text).not.toContain(arsip.key);

    // Nothing to purge: no audit row.
    const empty = await purgeExpired(env.DB, Date.parse('2000-01-01T00:00:00.000Z'));
    expect(empty).toEqual({ versions: 0, documents: 0, employees: 0, queueWrites: 0 });
  });

  it('counts one employee directly despite cascading documents, versions, sessions and SET NULL updates', async () => {
    const T = Date.parse('2002-01-01T00:00:00.000Z');
    const foto = await newKey('foto');
    const actor = await createUser({ fotoR2Key: foto });
    const survivor = await createUser();
    const a = await addArsip(actor.id, 'DOC-KTP');
    const b = await addArsip(actor.id, 'DOC-KK');
    for (const arsipId of [a.id, b.id]) {
      await addVersi(arsipId, 1, T + DAY);
      await addVersi(arsipId, 2, T + DAY);
    }
    const other = await addArsip(survivor.id, 'DOC-KTP');
    await env.DB.batch([
      ...[1, 2].map(() => env.DB.prepare(
        `INSERT INTO sesi(token_hash,pegawai_id,created_at,expires_at,last_seen_at) VALUES (?1,?2,?3,?4,?3)`,
      ).bind(crypto.randomUUID(), actor.id, iso(T - DAY), iso(T + DAY))),
      env.DB.prepare('UPDATE arsip_dokumen SET uploaded_by = ?2, verified_by = ?2 WHERE id = ?1')
        .bind(other.id, actor.id),
    ]);
    await softDeletePegawai(actor.id, T);

    const result = await purgeExpired(env.DB, T, { versions: 0, documents: 0 });
    expect(result).toEqual({ employees: 1, documents: 0, versions: 0, queueWrites: 7 });
    expect(await count('SELECT count(*) AS n FROM pegawai WHERE id = ?1', actor.id)).toBe(0);
    expect(await count('SELECT count(*) AS n FROM sesi WHERE pegawai_id = ?1', actor.id)).toBe(0);
    expect(await count('SELECT count(*) AS n FROM arsip_dokumen WHERE pegawai_id = ?1', actor.id)).toBe(0);
    expect(await count('SELECT count(*) AS n FROM arsip_dokumen_versi WHERE arsip_id IN (?1,?2)', a.id, b.id)).toBe(0);
    expect(await env.DB.prepare('SELECT uploaded_by, verified_by FROM arsip_dokumen WHERE id = ?1')
      .bind(other.id).first()).toEqual({ uploaded_by: null, verified_by: null });
    expect(JSON.parse(String(await env.DB.prepare(
      `SELECT description FROM log_aktivitas WHERE action = 'RETENTION_PURGE' AND ts = ?1`,
    ).bind(iso(T)).first('description')))).toEqual({ employees: 1, documents: 0, versions: 0 });
  });

  it('counts one document directly despite cascading versions, and queueWrites includes existing-key updates', async () => {
    const T = Date.parse('2003-01-01T00:00:00.000Z');
    const owner = await createUser();
    const arsip = await addArsip(owner.id, 'DOC-KTP', { deletedAt: T - 3 * DAY, purgeAfter: T });
    const v1 = await addVersi(arsip.id, 1, T + DAY);
    const v2 = await addVersi(arsip.id, 2, T + DAY);
    await env.DB.prepare(
      `INSERT INTO r2_purge_queue(object_key,bucket,source,enqueued_at,lease_token,lease_until)
       VALUES (?1,'FILES','TEST',?2,'existing-lease',?3)`,
    ).bind(arsip.key, iso(T - DAY), iso(T + DAY)).run();
    const before = await count('SELECT count(*) AS n FROM r2_purge_queue');

    const result = await purgeExpired(env.DB, T, { versions: 0, employees: 0 });
    // Three enqueue writes, but only two newly inserted keys: the current file's queue
    // row already existed and its conflict UPDATE only invalidated the previous lease.
    expect(result).toEqual({ employees: 0, documents: 1, versions: 0, queueWrites: 3 });
    expect(await count('SELECT count(*) AS n FROM r2_purge_queue')).toBe(before + 2);
    expect(await env.DB.prepare('SELECT lease_token, lease_until FROM r2_purge_queue WHERE object_key = ?1')
      .bind(arsip.key).first()).toEqual({ lease_token: null, lease_until: null });
    expect(await queued(v1)).toBe(true);
    expect(await queued(v2)).toBe(true);
    expect(await count('SELECT count(*) AS n FROM arsip_dokumen_versi WHERE arsip_id = ?1', arsip.id)).toBe(0);
    expect(JSON.parse(String(await env.DB.prepare(
      `SELECT description FROM log_aktivitas WHERE action = 'RETENTION_PURGE' AND ts = ?1`,
    ).bind(iso(T)).first('description')))).toEqual({ employees: 0, documents: 1, versions: 0 });
  });

  it('caps batch sizes', async () => {
    const T = Date.parse('2031-01-20T00:00:00.000Z');
    const user = await createUser();
    const arsip = await addArsip(user.id, 'DOC-KTP');
    for (let v = 1; v <= 3; v += 1) await addVersi(arsip.id, v, T - v);
    const res = await purgeExpired(env.DB, T, { versions: 2, documents: 0, employees: 0 });
    expect(res.versions).toBe(2);
    expect(await count('SELECT count(*) AS n FROM arsip_dokumen_versi WHERE arsip_id = ?1', arsip.id)).toBe(1);
  });
});
