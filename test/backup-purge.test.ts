import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { drainBackupPurgeQueue } from '../server/services/backup-purge';

async function enqueue(key: string) {
  await env.DB.prepare(`INSERT INTO r2_purge_queue(bucket,object_key,source,enqueued_at)
    VALUES('BACKUPS',?1,'BACKUP_EXPIRED',?2)`).bind(key, new Date().toISOString()).run();
}

describe('backup exact-key purge drain', () => {
  it('leaves queued parts alone when the backup bucket is unbound', async () => {
    const key = `backups/${crypto.randomUUID()}/one.ndjson`;
    await enqueue(key);
    expect((await drainBackupPurgeQueue({ DB: env.DB }, Date.now())).skipped).toBe(true);
    expect(await env.DB.prepare('SELECT 1 FROM r2_purge_queue WHERE object_key=?1').bind(key).first()).not.toBeNull();
  });

  it('deletes an unreferenced exact key but preserves a similarly prefixed object', async () => {
    const prefix = `backups/${crypto.randomUUID()}`;
    const key = `${prefix}/expired.ndjson`;
    const other = `${prefix}/still-active.ndjson`;
    await Promise.all([env.FILES.put(key, 'old'), env.FILES.put(other, 'keep')]);
    await enqueue(key);
    const result = await drainBackupPurgeQueue({ DB: env.DB, BACKUPS: env.FILES }, Date.now());
    expect(result.deleted).toBeGreaterThanOrEqual(1);
    expect(await env.FILES.head(key)).toBeNull();
    expect(await env.FILES.head(other)).not.toBeNull();
  });

  it('retains a queued part that still has a live database reference', async () => {
    const id = crypto.randomUUID();
    const key = `backups/${id}/active.ndjson`;
    const now = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO backup_job(id,status,started_at,purge_after,high_water_json)
      VALUES(?1,'RUNNING',?2,?3,'{}')`)
      .bind(id, now, new Date(Date.now() + 86_400_000).toISOString()).run();
    await env.DB.prepare(`INSERT INTO backup_part(job_id,sequence,table_name,first_rowid,last_rowid,object_key,rows,bytes,sha256,created_at)
      VALUES(?1,1,'pegawai',1,1,?2,1,4,'hash',?3)`).bind(id, key, now).run();
    await env.FILES.put(key, 'keep');
    await enqueue(key);
    const result = await drainBackupPurgeQueue({ DB: env.DB, BACKUPS: env.FILES }, Date.now());
    expect(result.referenced).toBeGreaterThanOrEqual(1);
    expect(await env.FILES.head(key)).not.toBeNull();
  });

  it('keeps a durable retry record after an R2 failure', async () => {
    const key = `backups/${crypto.randomUUID()}/retry.ndjson`;
    await enqueue(key);
    const del = vi.spyOn(env.FILES, 'delete').mockRejectedValueOnce(new Error('provider secret must not be stored'));
    try {
      const result = await drainBackupPurgeQueue({ DB: env.DB, BACKUPS: env.FILES }, Date.now());
      expect(result.failed).toBeGreaterThanOrEqual(1);
    } finally { del.mockRestore(); }
    const row = await env.DB.prepare('SELECT * FROM r2_purge_queue WHERE object_key=?1').bind(key).first();
    expect(row?.last_error).toBe('BACKUP_R2_DELETE_FAILED');
    expect(row?.lease_token).toBeNull();
    expect(row?.next_attempt_at).toBeTruthy();
    expect(JSON.stringify(row)).not.toContain('provider secret');
  });
});
