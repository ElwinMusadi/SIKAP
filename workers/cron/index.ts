import type { Bindings } from '../../server/env';
import { LOGIN_IP_LIMIT } from '../../server/services/auth';
import { flushOutbox } from '../../server/services/notifikasi';
import { drainPurgeQueue, purgeExpired } from '../../server/services/purge';
import { drainBackupPurgeQueue } from '../../server/services/backup-purge';
import { createBackupJob, purgeBackupJobs, runBackupSteps } from '../../server/services/backup';

export type CronBindings = Pick<Bindings, 'DB' | 'APP_URL' | 'SETTINGS_ENC_KEY'> &
  Partial<Pick<Bindings, 'FILES' | 'BACKUPS'>>;
export const RETRY_CRON = '*/10 * * * *';
export const CLEANUP_CRON = '0 18 * * *'; // 02:00 WITA

/** Bounded indexed deletes: no scan/read of employee data and no unbounded loop. */
export async function cleanupExpired(db: D1Database, nowMs: number, batchSize = 500) {
  const limit = Math.max(1, Math.min(Math.trunc(batchSize), 500));
  const now = new Date(nowMs).toISOString();
  // Only purge registered namespaces. Unknown counters may have longer windows;
  // deleting them by a blanket cutoff could silently bypass a future throttle.
  const loginFloor = new Date(nowMs - LOGIN_IP_LIMIT.windowMinutes * 60_000).toISOString();
  const waTestFloor = new Date(nowMs - 10 * 60_000).toISOString();
  const [sessions, windows] = await db.batch([
    db.prepare(`DELETE FROM sesi WHERE token_hash IN
      (SELECT token_hash FROM sesi WHERE expires_at <= ?1 ORDER BY expires_at LIMIT ?2)`)
      .bind(now, limit),
    db.prepare(`DELETE FROM rate_limit WHERE key IN
      (SELECT key FROM rate_limit
       WHERE (key LIKE 'login-ip:%' AND window_start <= ?1)
          OR (key LIKE 'wa-test:%' AND window_start <= ?2)
       ORDER BY window_start LIMIT ?3)`)
      .bind(loginFloor, waTestFloor, limit),
  ]);
  return { sessions: sessions?.meta.changes ?? 0, rateWindows: windows?.meta.changes ?? 0 };
}

export async function runScheduled(cron: string, env: CronBindings, nowMs: number): Promise<void> {
  if (cron === RETRY_CRON) {
    // Same bounded, leased sender used by Pages; no duplicate parallel claims.
    // One provider wave (3 x 8s concurrently) leaves room for bounded maintenance
    // in the same invocation. HTTP-triggered flushes may still use the larger limit.
    const counts = await flushOutbox(env, 'pending', 3, nowMs);
    console.log(JSON.stringify({ event: 'outbox_flush', ...counts }));
    if (env.FILES) {
      const deleted = await drainPurgeQueue({ ...env, FILES: env.FILES }, nowMs, 25);
      console.log(JSON.stringify({ event: 'r2_purge_drain', ...deleted }));
    }
    if (env.BACKUPS) {
      // A paused/manual export can continue in bounded chunks without a second schedule.
      const backup = await runBackupSteps(env, nowMs, 1);
      console.log(JSON.stringify({ event: 'backup_step', ...backup }));
      const purged = await drainBackupPurgeQueue(env, nowMs, 25);
      console.log(JSON.stringify({ event: 'backup_purge_drain', ...purged }));
    }
  } else if (cron === CLEANUP_CRON) {
    const counts = await cleanupExpired(env.DB, nowMs);
    console.log(JSON.stringify({ event: 'session_cleanup', ...counts }));
    if (env.FILES) {
      // Conservative batches on Free (10 ms CPU); reruns catch up without an unbounded loop.
      const purged = await purgeExpired(env.DB, nowMs, { versions: 25, documents: 10, employees: 2 });
      console.log(JSON.stringify({ event: 'retention_purge', ...purged }));
      const deleted = await drainPurgeQueue({ ...env, FILES: env.FILES }, nowMs, 25);
      console.log(JSON.stringify({ event: 'r2_purge_drain', ...deleted }));
    }
    if (env.BACKUPS) {
      const purged = await purgeBackupJobs(env, nowMs, 1);
      console.log(JSON.stringify({ event: 'backup_retention', ...purged }));
      // The unique RUNNING guard prevents duplicate daily/manual jobs. Handle only the
      // expected conflict, never suppress storage/auth failures as "already running".
      try { await createBackupJob(env, null, { nowMs }); }
      catch (error) {
        if (!(error instanceof Error && 'status' in error && error.status === 409)) throw error;
      }
      const backup = await runBackupSteps(env, nowMs, 1);
      console.log(JSON.stringify({ event: 'backup_step', ...backup }));
      const deleted = await drainBackupPurgeQueue(env, nowMs, 25);
      console.log(JSON.stringify({ event: 'backup_purge_drain', ...deleted }));
    }
  }
}

export default {
  scheduled(controller: ScheduledController, env: CronBindings, ctx: ExecutionContext): void {
    ctx.waitUntil(runScheduled(controller.cron, env, controller.scheduledTime).catch((error: unknown) => {
      // No provider bodies, phone numbers, tokens or exception messages in logs.
      console.error(JSON.stringify({ event: 'scheduled_failed', cron: controller.cron,
        errorType: error instanceof TypeError ? 'TypeError' : 'Error' }));
      // Rethrow a fixed error, never the original provider/DB error, for Cron Events.
      throw new Error('Scheduled task failed');
    }));
  },
};
