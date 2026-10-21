// Exact-key deletion of expired logical-backup parts. The backup job service enqueues
// keys and removes the job/parts in one D1 transaction; this drain never lists a bucket
// or deletes by prefix, and checks persisted parts again before touching R2.
import type { Bindings } from '../env';

export async function drainBackupPurgeQueue(
  env: Pick<Bindings, 'DB' | 'BACKUPS'>,
  nowMs: number,
  limit = 25,
) {
  const counts = { claimed: 0, deleted: 0, referenced: 0, failed: 0, skipped: !env.BACKUPS };
  if (!env.BACKUPS) return counts;
  const n = Math.max(1, Math.min(Number.isFinite(limit) ? Math.trunc(limit) : 25, 50));
  const now = new Date(nowMs).toISOString();
  const leaseUntil = new Date(Math.max(nowMs, Date.now()) + 300_000).toISOString();
  const token = crypto.randomUUID();
  const { results } = await env.DB.prepare(`UPDATE r2_purge_queue SET lease_token=?1,lease_until=?2
    WHERE bucket='BACKUPS' AND (lease_until IS NULL OR lease_until<=?3)
      AND object_key IN (SELECT object_key FROM r2_purge_queue
        WHERE bucket='BACKUPS' AND (next_attempt_at IS NULL OR next_attempt_at<=?3)
          AND (lease_until IS NULL OR lease_until<=?3)
        ORDER BY enqueued_at,object_key LIMIT ?4)
    RETURNING object_key`).bind(token, leaseUntil, now, n).all<{ object_key: string }>();
  counts.claimed = results.length;
  if (!results.length) return counts;
  const keys = results.map((row) => row.object_key);
  const json = JSON.stringify(keys);
  const refs = await env.DB.prepare(`SELECT value AS object_key FROM json_each(?1) k
    WHERE EXISTS(SELECT 1 FROM backup_part p WHERE p.object_key=k.value)`)
    .bind(json).all<{ object_key: string }>();
  const referenced = new Set(refs.results.map((row) => row.object_key));
  const unreferenced = keys.filter((key) => !referenced.has(key));
  counts.referenced = referenced.size;
  const finish = (done: string[]) => env.DB.prepare(`DELETE FROM r2_purge_queue
    WHERE bucket='BACKUPS' AND lease_token=?1 AND object_key IN(SELECT value FROM json_each(?2))`)
    .bind(token, JSON.stringify(done));
  try {
    if (unreferenced.length) await env.BACKUPS.delete(unreferenced);
  } catch {
    await env.DB.batch([
      finish([...referenced]),
      env.DB.prepare(`UPDATE r2_purge_queue SET attempts=attempts+1,lease_token=NULL,lease_until=NULL,
        last_error='BACKUP_R2_DELETE_FAILED',next_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ',?3,'+10 minutes')
        WHERE bucket='BACKUPS' AND lease_token=?1 AND object_key IN(SELECT value FROM json_each(?2))`)
        .bind(token, JSON.stringify(unreferenced), now),
    ]);
    counts.failed = unreferenced.length;
    return counts;
  }
  await finish(keys).run();
  counts.deleted = unreferenced.length;
  return counts;
}
