import type { Bindings } from '../../server/env';
import { LOGIN_IP_LIMIT } from '../../server/services/auth';
import { flushOutbox, FLUSH_LIMIT } from '../../server/services/notifikasi';

export type CronBindings = Pick<Bindings, 'DB' | 'APP_URL' | 'SETTINGS_ENC_KEY'>;
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
    const counts = await flushOutbox(env, 'pending', FLUSH_LIMIT, nowMs);
    console.log(JSON.stringify({ event: 'outbox_flush', ...counts }));
  } else if (cron === CLEANUP_CRON) {
    const counts = await cleanupExpired(env.DB, nowMs);
    console.log(JSON.stringify({ event: 'session_cleanup', ...counts }));
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
