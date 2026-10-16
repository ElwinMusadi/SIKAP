import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import scheduledWorker, { cleanupExpired, CLEANUP_CRON, RETRY_CRON, runScheduled } from '../workers/cron';
import { createUser } from './helpers';

afterEach(() => vi.restoreAllMocks());

describe('Phase 5 scheduled companion', () => {
  it('removes only expired sessions and rate windows', async () => {
    const user = await createUser();
    const now = Date.parse('2030-01-01T00:00:00.000Z');
    const old = new Date(now - 60_000).toISOString();
    const future = new Date(now + 60_000).toISOString();
    const expired = crypto.randomUUID();
    const valid = crypto.randomUUID();
    const oldWindow = `login-ip:${crypto.randomUUID()}`;
    const freshWindow = `login-ip:${crypto.randomUUID()}`;
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO sesi(token_hash,pegawai_id,created_at,expires_at,last_seen_at)
        VALUES (?1,?2,?3,?4,?3)`).bind(expired, user.id, old, old),
      env.DB.prepare(`INSERT INTO sesi(token_hash,pegawai_id,created_at,expires_at,last_seen_at)
        VALUES (?1,?2,?3,?4,?3)`).bind(valid, user.id, old, future),
      env.DB.prepare(`INSERT INTO rate_limit(key,window_start,count) VALUES (?1,?2,1)`)
        .bind(oldWindow, new Date(now - 16 * 60_000).toISOString()),
      env.DB.prepare(`INSERT INTO rate_limit(key,window_start,count) VALUES (?1,?2,1)`)
        .bind(freshWindow, new Date(now - 5 * 60_000).toISOString()),
    ]);
    const result = await cleanupExpired(env.DB, now);
    expect(result.sessions).toBeGreaterThanOrEqual(1);
    expect(result.rateWindows).toBeGreaterThanOrEqual(1);
    expect(await env.DB.prepare('SELECT 1 FROM sesi WHERE token_hash=?1').bind(expired).first()).toBeNull();
    expect(await env.DB.prepare('SELECT 1 FROM sesi WHERE token_hash=?1').bind(valid).first()).not.toBeNull();
    expect(await env.DB.prepare('SELECT 1 FROM rate_limit WHERE key=?1').bind(oldWindow).first()).toBeNull();
    expect(await env.DB.prepare('SELECT 1 FROM rate_limit WHERE key=?1').bind(freshWindow).first()).not.toBeNull();
  });

  it('does not execute anything for an unknown cron expression', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await runScheduled('unknown', env, Date.now());
    expect(fetch).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('honours a small batch cap, oldest-first, and preserves unknown counter namespaces', async () => {
    // Earlier than any other test fixture so batchSize=1 deterministically chooses ours.
    const now = Date.parse('2000-01-01T00:00:00.000Z');
    const keys = Array.from({ length: 3 }, () => `login-ip:${crypto.randomUUID()}`);
    const unknown = `future-throttle:${crypto.randomUUID()}`;
    await env.DB.batch([
      ...keys.map((key, index) => env.DB.prepare(`INSERT INTO rate_limit(key,window_start,count) VALUES (?1,?2,1)`)
        .bind(key, new Date(now - (60 - index) * 60_000).toISOString())),
      env.DB.prepare(`INSERT INTO rate_limit(key,window_start,count) VALUES (?1,?2,1)`)
        .bind(unknown, new Date(now - 86_400_000).toISOString()),
    ]);
    const result = await cleanupExpired(env.DB, now, 1);
    expect(result.rateWindows).toBe(1);
    expect(await env.DB.prepare('SELECT 1 FROM rate_limit WHERE key=?1').bind(keys[0]).first()).toBeNull();
    expect(await env.DB.prepare('SELECT 1 FROM rate_limit WHERE key=?1').bind(keys[1]).first()).not.toBeNull();
    expect(await env.DB.prepare('SELECT 1 FROM rate_limit WHERE key=?1').bind(unknown).first()).not.toBeNull();
  });

  it('scheduled entry attaches work to its execution context', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const ctx = createExecutionContext();
    scheduledWorker.scheduled(createScheduledController({ cron: CLEANUP_CRON, scheduledTime: Date.now() }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ event: 'session_cleanup' });
  });

  it('scheduled failures retain a safe diagnostic and reject without leaking the cause', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const batch = vi.spyOn(env.DB, 'batch').mockRejectedValueOnce(new Error('private database detail'));
    const ctx = createExecutionContext();
    scheduledWorker.scheduled(createScheduledController({ cron: CLEANUP_CRON, scheduledTime: Date.now() }), env, ctx);
    await expect(waitOnExecutionContext(ctx)).rejects.toThrow('Scheduled task failed');
    expect(batch).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(JSON.stringify({ event: 'scheduled_failed', cron: CLEANUP_CRON, errorType: 'Error' }));
    expect(JSON.stringify(log.mock.calls)).not.toContain('private database detail');
  });

  it('scheduled cleanup emits only counts', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await runScheduled(CLEANUP_CRON, env, Date.now());
    expect(log).toHaveBeenCalledTimes(1);
    const data = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(data).toEqual({ event: 'session_cleanup', sessions: expect.any(Number), rateWindows: expect.any(Number) });
  });

  it('retry with no provider never calls the external API', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await runScheduled(RETRY_CRON, env, Date.now());
    expect(fetch).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ event: 'outbox_flush' });
  });
});
