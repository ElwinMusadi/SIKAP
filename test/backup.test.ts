import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../server/app';
import { advanceGuarded, insertPartGuarded } from '../server/db/backup';
import type { Bindings } from '../server/env';
import { BACKUP_TABLES, type BackupJob, type BackupJobResponse } from '../shared/backup';
import {
  BACKUP_LIMITS,
  createBackupJob,
  getBackupJob,
  getManifestDownload,
  getPartDownload,
  purgeBackupJobs,
  stepBackup,
} from '../server/services/backup';
import { createUser, login, ORIGIN, uniqueIp } from './helpers';

const configured: Bindings = { ...env, BACKUPS: env.FILES };
const missing: Bindings = { ...env, BACKUPS: undefined };

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM backup_job'),
    env.DB.prepare("DELETE FROM r2_purge_queue WHERE bucket='BACKUPS'"),
    env.DB.prepare("DELETE FROM log_aktivitas WHERE action LIKE 'BACKUP_%' OR action LIKE 'TEST_%'"),
    env.DB.prepare("DELETE FROM pengaturan WHERE key LIKE 'test.%'"),
  ]);
});
afterEach(() => vi.restoreAllMocks());

function request(path: string, cookie?: string, opts: { method?: string; origin?: string; bindings?: Bindings; body?: string } = {}) {
  const headers: Record<string, string> = { 'CF-Connecting-IP': uniqueIp() };
  if (cookie) headers.Cookie = cookie;
  if (opts.origin !== undefined) headers.Origin = opts.origin;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  return app.request(`${ORIGIN}/api/admin/backup${path}`, { method: opts.method ?? 'GET', headers, body: opts.body }, opts.bindings ?? configured);
}

async function finish(id: string, nowMs = Date.now()): Promise<BackupJob> {
  for (let i = 0; i < 100; i += 1) {
    const { job } = await stepBackup(configured, id, null, nowMs);
    if (job.status !== 'RUNNING') return job;
  }
  throw new Error('backup exceeded 100 bounded steps');
}

async function exportText(job: BackupJob): Promise<string> {
  const texts: string[] = [];
  for (const part of job.parts) {
    const file = await getPartDownload(configured, job.id, String(part.sequence));
    texts.push(await new Response(file.body).text());
  }
  return texts.join('');
}

async function manifest(id: string): Promise<Record<string, unknown>> {
  const file = await getManifestDownload(configured, id);
  return JSON.parse(await new Response(file.body).text()) as Record<string, unknown>;
}

describe('resumable private logical backup', () => {
  it('lists configured:false and rejects creation/step safely without BACKUPS', async () => {
    const cookie = await login(await createUser({ role: 'Admin' }));
    const list = await request('', cookie, { bindings: missing });
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ configured: false, jobs: [] });
    for (const path of ['', `/${crypto.randomUUID()}/step`]) {
      const res = await request(path, cookie, { bindings: missing, method: 'POST', origin: ORIGIN });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Penyimpanan backup belum dikonfigurasi.' } });
    }
    expect(await env.DB.prepare('SELECT count(*) AS n FROM backup_job').first('n')).toBe(0);
  });

  it('protects all endpoints with sessions, admin role, CSRF and a 16 KB body limit', async () => {
    const pegawai = await login(await createUser());
    const admin = await login(await createUser({ role: 'Admin' }));
    for (const path of ['', `/${crypto.randomUUID()}`, `/${crypto.randomUUID()}/parts/1`, `/${crypto.randomUUID()}/manifest`]) {
      expect((await request(path)).status).toBe(401);
      expect((await request(path, pegawai)).status).toBe(403);
    }
    expect((await request('', admin, { method: 'POST' })).status).toBe(403);
    expect((await request('', admin, { method: 'POST', origin: 'https://evil.test' })).status).toBe(403);
    expect((await request('', pegawai, { method: 'POST', origin: ORIGIN })).status).toBe(403);
    expect((await request('', admin, { method: 'POST', origin: ORIGIN, body: JSON.stringify({ pad: 'x'.repeat(17 * 1024) }) })).status).toBe(400);
  });

  it('creates UUID job with 201, rejects another active job, and audits once', async () => {
    const cookie = await login(await createUser({ role: 'Admin' }));
    const res = await request('', cookie, { method: 'POST', origin: ORIGIN });
    expect(res.status).toBe(201);
    const { job } = await res.json<BackupJobResponse>();
    expect(job.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(job).toMatchObject({ status: 'RUNNING', consistent: false, includesFileBytes: false, parts: [], rowCount: 0 });
    expect(Date.parse(job.purgeAfter) - Date.parse(job.startedAt)).toBe(30 * 86_400_000);
    expect((await request('', cookie, { method: 'POST', origin: ORIGIN })).status).toBe(409);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM log_aktivitas WHERE action='BACKUP_CREATE'").first('n')).toBe(1);
  });

  it('exports every table in bounded steps and generates honest schema/migration manifest without file bytes or session secrets', async () => {
    const user = await createUser({ role: 'Admin', passwordHash: 'intended-password-hash' });
    await env.DB.prepare("INSERT INTO pengaturan(key,value,is_secret) VALUES ('test.backup.ciphertext', 'intended-encrypted-ciphertext', 1)").run();
    const now = new Date().toISOString();
    await env.DB.prepare('INSERT INTO sesi(token_hash,pegawai_id,created_at,expires_at,last_seen_at) VALUES (?1,?2,?3,?4,?3)')
      .bind('forbidden-session-token', user.id, now, new Date(Date.now() + 60_000).toISOString()).run();
    await env.FILES.put('source-file-never-read', 'FILE_BYTES_MUST_NOT_BE_EXPORTED');
    const get = vi.spyOn(env.FILES, 'get');
    const { job: created } = await createBackupJob(configured);
    const job = await finish(created.id);
    expect(job.status).toBe('DONE');
    expect(job.tablesCompleted).toBe(13);
    expect(job.parts.length).toBeGreaterThan(0);
    expect(get).not.toHaveBeenCalled();
    for (const p of job.parts) {
      expect(p.rows).toBeLessThanOrEqual(200);
      expect(p.bytes).toBeLessThanOrEqual(256 * 1024);
    }
    const m = await manifest(job.id);
    expect(m).toMatchObject({ consistent: false, pointInTime: false, includesFileBytes: false });
    expect(m.excludedTables).toEqual(expect.arrayContaining(['sesi', 'rate_limit', 'notifikasi_outbox', 'r2_purge_queue', 'backup_job', 'backup_part']));
    expect(m.schema).toEqual(expect.arrayContaining([expect.objectContaining({ table: 'pegawai', type: 'table', sql: expect.stringContaining('CREATE TABLE') })]));
    expect(m.migrations).toEqual(expect.arrayContaining([expect.objectContaining({ name: '0008_backup_jobs.sql' })]));
    expect(m.totals).toEqual({ rows: job.rowCount, bytes: job.byteCount, parts: job.parts.length });
    const text = await exportText(job);
    expect(text).toContain('intended-password-hash');
    expect(text).toContain('intended-encrypted-ciphertext');
    for (const forbidden of ['forbidden-session-token', env.PASSWORD_PEPPER, env.SETTINGS_ENC_KEY, 'FILE_BYTES_MUST_NOT_BE_EXPORTED']) {
      expect(text).not.toContain(forbidden);
      expect(JSON.stringify(m)).not.toContain(forbidden);
    }
    expect(await env.DB.prepare("SELECT count(*) AS n FROM log_aktivitas WHERE action='BACKUP_DONE'").first('n')).toBe(1);
    expect((await stepBackup(configured, job.id)).job).toEqual(job);
  });

  it('streams persisted NDJSON parts privately, admin only and only for their own job', async () => {
    const admin = await login(await createUser({ role: 'Admin' }));
    const pegawai = await login(await createUser());
    const { job: created } = await createBackupJob(configured);
    const { job } = await stepBackup(configured, created.id);
    const p = job.parts[0]!;
    expect(p.sequence).toBe(1);
    const path = `/${job.id}/parts/${p.sequence}`;
    expect((await request(path)).status).toBe(401);
    expect((await request(path, pegawai)).status).toBe(403);
    expect((await request(`/${crypto.randomUUID()}/parts/1`, admin)).status).toBe(404);
    expect((await request(`/${job.id}/parts/0`, admin)).status).toBe(404);
    const res = await request(path, admin);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/x-ndjson');
    expect(res.headers.get('Content-Disposition')).toMatch(/^attachment; filename="sikap-backup-/);
    expect(res.headers.get('Cache-Control')).toContain('no-store');
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    const text = await res.text();
    expect(new TextEncoder().encode(text).byteLength).toBe(p.bytes);
    expect(text.trim().split('\n').map((line) => JSON.parse(line))).toHaveLength(p.rows);
    expect(text).not.toContain('__backup_rowid');
    expect((await request(`/${job.id}/manifest`, admin)).status).toBe(404);
  });

  it('uses high-water rowids so continuously appended history cannot prevent completion', async () => {
    await env.DB.prepare("INSERT INTO log_aktivitas(ts,action,result,description) VALUES (?1,'TEST_BEFORE','SUCCESS','before-highwater')").bind(new Date().toISOString()).run();
    const { job: created } = await createBackupJob(configured);
    let job = created;
    for (let i = 0; i < 100 && job.status === 'RUNNING'; i += 1) {
      await env.DB.prepare("INSERT INTO log_aktivitas(ts,action,result,description) VALUES (?1,'TEST_APPEND','SUCCESS','after-highwater')").bind(new Date().toISOString()).run();
      job = (await stepBackup(configured, job.id)).job;
    }
    expect(job.status).toBe('DONE');
    const text = await exportText(job);
    expect(text).toContain('before-highwater');
    expect(text).not.toContain('after-highwater');
    expect(text).not.toContain('BACKUP_CREATE');
  });

  it('parallel steps lease the cursor without duplicate sequences or objects', async () => {
    const { job } = await createBackupJob(configured);
    await Promise.all(Array.from({ length: 5 }, () => stepBackup(configured, job.id)));
    const row = await env.DB.prepare('SELECT part_seq,row_count,byte_count,lease_token FROM backup_job WHERE id=?1').bind(job.id)
      .first<{ part_seq: number; row_count: number; byte_count: number; lease_token: string | null }>();
    const parts = (await env.DB.prepare('SELECT sequence,object_key,rows,bytes FROM backup_part WHERE job_id=?1 ORDER BY sequence').bind(job.id)
      .all<{ sequence: number; object_key: string; rows: number; bytes: number }>()).results;
    expect(parts.length).toBeGreaterThan(0);
    expect(row?.part_seq).toBe(parts.length);
    expect(parts.map((p) => p.sequence)).toEqual(parts.map((_, i) => i + 1));
    expect(new Set(parts.map((p) => p.object_key)).size).toBe(parts.length);
    expect(row?.row_count).toBe(parts.reduce((sum, p) => sum + p.rows, 0));
    expect(row?.byte_count).toBe(parts.reduce((sum, p) => sum + p.bytes, 0));
    expect(row?.lease_token).toBeNull();
  });

  it('keeps part insertion and cursor advance atomic across lease expiry between statements', async () => {
    const { job } = await createBackupJob(configured);
    await env.DB.prepare(`CREATE TRIGGER backup_test_expire_lease AFTER INSERT ON backup_part BEGIN
      UPDATE backup_job SET lease_until='2000-01-01T00:00:00.000Z' WHERE id=NEW.job_id;
    END`).run();
    try {
      const stepped = (await stepBackup(configured, job.id)).job;
      expect(stepped.parts).toHaveLength(1);
      const row = await env.DB.prepare('SELECT part_seq,row_count,byte_count,lease_token FROM backup_job WHERE id=?1')
        .bind(job.id).first<{ part_seq: number; row_count: number; byte_count: number; lease_token: string | null }>();
      expect(row).toEqual({ part_seq: 1, row_count: stepped.parts[0]!.rows, byte_count: stepped.parts[0]!.bytes, lease_token: null });
    } finally {
      await env.DB.prepare('DROP TRIGGER backup_test_expire_lease').run();
    }
    expect((await stepBackup(configured, job.id)).job.parts).toHaveLength(2);
  });

  it('does not checkpoint when the preceding part insertion loses the lease', async () => {
    const { job } = await createBackupJob(configured);
    const token = crypto.randomUUID();
    await env.DB.prepare('UPDATE backup_job SET lease_token=?2,lease_until=?3 WHERE id=?1')
      .bind(job.id, token, new Date(Date.now() - 1000).toISOString()).run();
    const cur = { token, tblIdx: 0, lastRowid: 0, partSeq: 0 };
    const result = await env.DB.batch([
      insertPartGuarded(env.DB, job.id, {
        sequence: 1, table: 'ref_pangkat_golongan', firstRowid: 1, lastRowid: 1,
        objectKey: `backups/${job.id}/uncommitted.ndjson`, rows: 1, bytes: 10,
        sha256: '0'.repeat(64), createdAt: new Date().toISOString(),
      }, cur),
      advanceGuarded(env.DB, job.id, { tblIdx: 0, lastRowid: 1, parts: 1, rows: 1, bytes: 10 }, cur),
    ]);
    expect(result.map((r) => r.meta.changes)).toEqual([0, 0]);
    expect(await env.DB.prepare('SELECT part_seq,last_rowid,row_count,byte_count FROM backup_job WHERE id=?1')
      .bind(job.id).first()).toEqual({ part_seq: 0, last_rowid: 0, row_count: 0, byte_count: 0 });
    expect(await env.DB.prepare('SELECT 1 FROM backup_part WHERE job_id=?1').bind(job.id).first()).toBeNull();
  });

  it('caps escaped JSON chunks and advances only through rows actually included', async () => {
    const value = '\u0001'.repeat(20_000);
    await env.DB.batch(['test.chunk.a', 'test.chunk.b', 'test.chunk.c'].map((key) =>
      env.DB.prepare('INSERT INTO pengaturan(key,value) VALUES (?1,?2)').bind(key, value)));
    const { job: created } = await createBackupJob(configured);
    const job = await finish(created.id);
    expect(job.status).toBe('DONE');
    const parts = job.parts.filter((p) => p.table === 'pengaturan');
    expect(parts.length).toBeGreaterThanOrEqual(2);
    const rows: { key: string; value: string }[] = [];
    for (const part of parts) {
      const file = await getPartDownload(configured, job.id, String(part.sequence));
      const text = await new Response(file.body).text();
      expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(256 * 1024);
      rows.push(...text.trim().split('\n').map((line) => JSON.parse(line) as { key: string; value: string }));
    }
    expect(rows.filter((r) => r.key.startsWith('test.chunk.')).map((r) => r.key).sort())
      .toEqual(['test.chunk.a', 'test.chunk.b', 'test.chunk.c']);
    expect(rows.filter((r) => r.key.startsWith('test.chunk.')).every((r) => r.value === value)).toBe(true);
  });

  it('does not inherit a purged admin identity when their numeric ID is reused', async () => {
    const cookie = await login(await createUser({ role: 'Admin' }));
    const res = await request('', cookie, { method: 'POST', origin: ORIGIN });
    const { job } = await res.json<BackupJobResponse>();
    const actorId = job.startedBy!.id;
    await env.DB.prepare('DELETE FROM pegawai WHERE id=?1').bind(actorId).run();
    await env.DB.prepare("INSERT INTO pegawai(id,nip,nama,role) VALUES (?1,?2,'different employee','Pegawai')")
      .bind(actorId, `99${String(actorId).padStart(16, '0')}`).run();
    expect((await getBackupJob(configured, job.id)).job.startedBy).toBeNull();
  });

  it('marks put failure FAILED with controlled error and does not advance cursor', async () => {
    const { job } = await createBackupJob(configured);
    vi.spyOn(env.FILES, 'put').mockRejectedValueOnce(new Error('provider-secret-DO-NOT-LEAK'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failed = (await stepBackup(configured, job.id)).job;
    expect(failed).toMatchObject({ status: 'FAILED', errorCode: 'BACKUP_STORAGE_ERROR', rowCount: 0, byteCount: 0, parts: [] });
    expect(JSON.stringify(failed)).not.toContain('provider-secret');
    expect(await env.DB.prepare('SELECT last_rowid FROM backup_job WHERE id=?1').bind(job.id).first('last_rowid')).toBe(0);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM log_aktivitas WHERE action='BACKUP_FAILED'").first('n')).toBe(1);
  });

  it('rejects oversized rows and honours the part/job caps without cursor advancement', async () => {
    await env.DB.prepare('INSERT INTO pengaturan(key,value) VALUES (?1,?2)').bind('test.oversized', '\u0001'.repeat(50_000)).run();
    const { job: created } = await createBackupJob(configured);
    const job = await finish(created.id);
    expect(job).toMatchObject({ status: 'FAILED', errorCode: 'BACKUP_ROW_LIMIT' });
    const next = await createBackupJob(configured);
    await env.DB.prepare('UPDATE backup_job SET part_seq=?2 WHERE id=?1').bind(next.job.id, BACKUP_LIMITS.jobMaxParts).run();
    expect((await stepBackup(configured, next.job.id)).job).toMatchObject({ status: 'FAILED', errorCode: 'BACKUP_SIZE_LIMIT', parts: [] });
  });

  it('hides expired jobs and atomically queues only their exact persisted part keys before cascading deletion', async () => {
    const { job: created } = await createBackupJob(configured);
    const job = await finish(created.id);
    const keys = (await env.DB.prepare('SELECT object_key FROM backup_part WHERE job_id=?1').bind(job.id).all<{ object_key: string }>()).results.map((p) => p.object_key);
    const expires = Date.parse(job.purgeAfter);
    await expect(getBackupJob(configured, job.id, expires)).rejects.toMatchObject({ status: 404 });
    await expect(getPartDownload(configured, job.id, '1', expires)).rejects.toMatchObject({ status: 404 });
    await expect(getManifestDownload(configured, job.id, expires)).rejects.toMatchObject({ status: 404 });
    const result = await purgeBackupJobs(configured, expires);
    expect(result).toMatchObject({ jobsDeleted: 1, keysQueued: keys.length });
    expect(await env.DB.prepare('SELECT 1 FROM backup_job WHERE id=?1').bind(job.id).first()).toBeNull();
    expect(await env.DB.prepare('SELECT 1 FROM backup_part WHERE job_id=?1').bind(job.id).first()).toBeNull();
    const queued = (await env.DB.prepare("SELECT object_key FROM r2_purge_queue WHERE bucket='BACKUPS'").all<{ object_key: string }>()).results.map((r) => r.object_key);
    expect(queued.sort()).toEqual(keys.sort());
    expect(await env.FILES.head(keys[0]!)).not.toBeNull(); // queueing is not deletion
  });

  it.each([
    ['missing high-water keys', '{}'],
    ['numeric-string high-water', JSON.stringify({ ...Object.fromEntries(BACKUP_TABLES.map((t) => [t, 0])), pegawai: '0' })],
  ])('fails closed for %s without parts or a DONE audit', async (_label, metadata) => {
    const { job } = await createBackupJob(configured);
    await env.DB.prepare('UPDATE backup_job SET high_water_json=?2 WHERE id=?1').bind(job.id, metadata).run();
    const failed = (await stepBackup(configured, job.id)).job;
    expect(failed).toMatchObject({ status: 'FAILED', errorCode: 'BACKUP_METADATA_ERROR', rowCount: 0, byteCount: 0, parts: [] });
    expect(await env.DB.prepare("SELECT count(*) AS n FROM log_aktivitas WHERE action='BACKUP_DONE'").first('n')).toBe(0);
    const audit = await env.DB.prepare("SELECT description FROM log_aktivitas WHERE action='BACKUP_FAILED' AND target_id=?1")
      .bind(job.id).first<{ description: string }>();
    expect(audit?.description).toContain('BACKUP_METADATA_ERROR');
    expect(audit?.description).not.toContain(metadata);
    expect(await env.DB.prepare('SELECT lease_token FROM backup_job WHERE id=?1').bind(job.id).first('lease_token')).toBeNull();
  });

  it('accepts valid all-zero high-water metadata and completes an empty export', async () => {
    const { job } = await createBackupJob(configured);
    await env.DB.prepare('UPDATE backup_job SET high_water_json=?2 WHERE id=?1')
      .bind(job.id, JSON.stringify(Object.fromEntries(BACKUP_TABLES.map((t) => [t, 0])))).run();
    const done = (await stepBackup(configured, job.id)).job;
    expect(done).toMatchObject({ status: 'DONE', errorCode: null, rowCount: 0, byteCount: 0, parts: [], tablesCompleted: BACKUP_TABLES.length });
    expect((await manifest(job.id)).totals).toEqual({ rows: 0, bytes: 0, parts: 0 });
  });

  it('fails an expired abandoned RUNNING job so a new job can start', async () => {
    const { job: old } = await createBackupJob(configured);
    await env.DB.prepare('UPDATE backup_job SET purge_after=?2 WHERE id=?1').bind(old.id, new Date(Date.now() - 1000).toISOString()).run();
    const { job } = await createBackupJob(configured);
    expect(job.status).toBe('RUNNING');
    expect(job.id).not.toBe(old.id);
    expect(await env.DB.prepare('SELECT status,error_code FROM backup_job WHERE id=?1').bind(old.id).first()).toEqual({ status: 'FAILED', error_code: 'BACKUP_EXPIRED' });
  });
});
