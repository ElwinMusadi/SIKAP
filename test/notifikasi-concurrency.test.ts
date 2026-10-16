// Outbox claim/lease semantics (migration 0005): overlapping flushes, lease expiry,
// per-row persistence, time budget and unconfigured providers.
import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptSetting } from '../server/lib/secrets';
import { FLUSH_LIMIT, flushOutbox, LEASE_MS, MAX_PARALLEL, UNCONFIGURED_DELAY_MS } from '../server/services/notifikasi';
import { fonnteOk, uniquePhone } from './phase5-helpers';

const TOKEN = 'concurrency-secret-TOKEN-x1';

async function setFonnte(token: string | null): Promise<void> {
  const stmts = [
    env.DB.prepare(
      `INSERT INTO pengaturan (key, value) VALUES ('wa.provider', 'fonnte')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ),
  ];
  stmts.push(
    token === null
      ? env.DB.prepare(`DELETE FROM pengaturan WHERE key = 'wa.fonnte.token'`)
      : env.DB.prepare(
          `INSERT INTO pengaturan (key, value, is_secret) VALUES ('wa.fonnte.token', ?1, 1)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, is_secret = 1`,
        ).bind(await encryptSetting(token, env.SETTINGS_ENC_KEY)),
  );
  await env.DB.batch(stmts);
}

async function insertRow(opts: { attempts?: number; createdAt?: string; nextAttemptAt?: string | null } = {}) {
  const target = uniquePhone();
  const row = await env.DB.prepare(
    `INSERT INTO notifikasi_outbox (target, template, params, attempts, created_at, next_attempt_at)
     VALUES (?1, 'dokumen_terverifikasi', '{"nama":"Budi","namaDokumen":"KTP"}', ?2, ?3, ?4) RETURNING id`,
  )
    .bind(target, opts.attempts ?? 0, opts.createdAt ?? new Date().toISOString(), opts.nextAttemptAt ?? null)
    .first<{ id: number }>();
  return { id: row!.id, target };
}

async function rowOf(id: number) {
  return env.DB.prepare(`SELECT * FROM notifikasi_outbox WHERE id = ?1`).bind(id).first<Record<string, unknown>>();
}

/** Provider stub: `respond(target, callIndex)` decides each response; records targets in order. */
function stubProvider(respond: (target: string, n: number) => Response | Promise<Response>) {
  const targets: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    const target = new URLSearchParams(String(init?.body)).get('target') ?? '';
    targets.push(target);
    return respond(target, targets.length);
  });
  return targets;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => setFonnte(TOKEN));
afterEach(() => vi.restoreAllMocks());

describe('flushOutbox leases', () => {
  it('two concurrent flushes of the same ids send each row once', async () => {
    const a = await insertRow();
    const b = await insertRow();
    const targets = stubProvider(async () => {
      await new Promise((r) => setTimeout(r, 30)); // keep both flushes in flight together
      return fonnteOk();
    });
    const [r1, r2] = await Promise.all([flushOutbox(env, [a.id, b.id]), flushOutbox(env, [a.id, b.id])]);
    expect(targets.sort()).toEqual([a.target, b.target].sort());
    expect(r1.sent + r2.sent).toBe(2);
    expect(r1.failed + r2.failed).toBe(0);
    for (const id of [a.id, b.id]) {
      expect(await rowOf(id)).toMatchObject({ status: 'SENT', attempts: 1, lease_token: null, lease_until: null });
    }
  });

  it("a cron-style 'pending' flush and an id flush overlapping still send once", async () => {
    const r = await insertRow({ createdAt: '2000-01-01T00:00:00.000Z' }); // oldest → first in 'pending'
    const targets = stubProvider(async () => {
      await new Promise((res) => setTimeout(res, 30));
      return fonnteOk();
    });
    await Promise.all([flushOutbox(env, [r.id]), flushOutbox(env, 'pending', 1)]);
    expect(targets.filter((t) => t === r.target)).toHaveLength(1);
    expect(await rowOf(r.id)).toMatchObject({ status: 'SENT', attempts: 1 });
  });

  it('a live lease blocks other flushes; an expired lease is recovered', async () => {
    const now = Date.now();
    const r = await insertRow();
    await env.DB.prepare(`UPDATE notifikasi_outbox SET lease_token = 'crashed', lease_until = ?2 WHERE id = ?1`)
      .bind(r.id, new Date(now + LEASE_MS).toISOString())
      .run();
    const targets = stubProvider(() => fonnteOk());
    expect(await flushOutbox(env, [r.id], undefined, now + 1000)).toEqual({ sent: 0, failed: 0, skipped: 0 });
    expect(targets).toHaveLength(0);
    expect(await flushOutbox(env, [r.id], undefined, now + LEASE_MS + 1)).toEqual({ sent: 1, failed: 0, skipped: 0 });
    expect(await rowOf(r.id)).toMatchObject({ status: 'SENT', attempts: 1, lease_token: null });
  });

  it('a stale lease holder cannot overwrite the row after its lease was taken over', async () => {
    const now = Date.now();
    const r = await insertRow();
    const slow = deferred<Response>();
    const targets = stubProvider((_t, n) => (n === 1 ? slow.promise : fonnteOk()));
    const first = flushOutbox(env, [r.id], undefined, now);
    await vi.waitFor(() => expect(targets).toHaveLength(1));
    // First holder is stuck past its lease; another flush takes over and succeeds.
    // (+5 s: the first lease is based on the real clock, a few ms after `now`.)
    expect((await flushOutbox(env, [r.id], undefined, now + LEASE_MS + 5_000)).sent).toBe(1);
    // The stuck request finally fails: its update is ignored (lease token no longer matches).
    slow.resolve(new Response('{"status":false,"reason":"device disconnected"}', { status: 200 }));
    // Its outcome was not persisted, so it is not counted as failed.
    expect(await first).toEqual({ sent: 0, failed: 0, skipped: 1 });
    expect(await rowOf(r.id)).toMatchObject({ status: 'SENT', attempts: 1, last_error: null, lease_token: null });
    // At-least-once: the message reached the provider twice in this scenario.
    expect(targets).toEqual([r.target, r.target]);
  });

  it('a stale nowMs (delayed cron) still gets a full lease from the real clock', async () => {
    const r = await insertRow({ createdAt: '2000-01-01T00:00:00.000Z' });
    const slow = deferred<Response>();
    const targets = stubProvider(() => slow.promise);
    const staleNow = Date.now() - 5 * 60_000;
    const run = flushOutbox(env, [r.id], undefined, staleNow);
    await vi.waitFor(() => expect(targets).toHaveLength(1));
    const leaseUntil = Date.parse(String((await rowOf(r.id))?.lease_until));
    expect(leaseUntil).toBeGreaterThanOrEqual(Date.now() + LEASE_MS - 5_000);
    // A concurrent flush at the real time cannot steal the row mid-send.
    expect(await flushOutbox(env, [r.id], undefined, Date.now())).toEqual({ sent: 0, failed: 0, skipped: 0 });
    slow.resolve(fonnteOk());
    expect(await run).toEqual({ sent: 1, failed: 0, skipped: 0 });
    expect(targets).toHaveLength(1);
  });

  it("each row's outcome is persisted immediately; a slow failing row does not hold back sent rows", async () => {
    const ok = await insertRow();
    const bad = await insertRow();
    const slow = deferred<Response>();
    stubProvider((t) => (t === bad.target ? slow.promise : fonnteOk()));
    const run = flushOutbox(env, [ok.id, bad.id]);
    await vi.waitFor(async () => expect((await rowOf(ok.id))?.status).toBe('SENT'));
    expect(await rowOf(bad.id)).toMatchObject({ status: 'PENDING', attempts: 0 });
    expect((await rowOf(bad.id))?.lease_token).toBeTruthy();
    slow.resolve(new Response('upstream down', { status: 503 }));
    expect(await run).toEqual({ sent: 1, failed: 1, skipped: 0 });
    expect(await rowOf(ok.id)).toMatchObject({ status: 'SENT', attempts: 1 });
    expect(await rowOf(bad.id)).toMatchObject({
      status: 'PENDING',
      attempts: 1,
      last_error: 'HTTP 503: Layanan Fonnte sedang bermasalah.',
      lease_token: null,
    });
  });

  it(`at most ${MAX_PARALLEL} sends in flight and at most ${FLUSH_LIMIT} rows per flush`, async () => {
    const rows = [];
    for (let i = 0; i < FLUSH_LIMIT + 2; i++) rows.push(await insertRow());
    let inFlight = 0;
    let peak = 0;
    const targets = stubProvider(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight -= 1;
      return fonnteOk();
    });
    const res = await flushOutbox(env, rows.map((r) => r.id), 50);
    expect(res.sent).toBe(FLUSH_LIMIT);
    expect(targets).toHaveLength(FLUSH_LIMIT);
    expect(peak).toBeLessThanOrEqual(MAX_PARALLEL);
    const left = await rowOf(rows[rows.length - 1]!.id);
    expect(left).toMatchObject({ status: 'PENDING', attempts: 0, lease_token: null });
  });

  it('stops starting sends near the time budget and releases unstarted rows untouched', async () => {
    const rows = [];
    for (let i = 0; i < FLUSH_LIMIT; i++) rows.push(await insertRow());
    let t = 0;
    const targets = stubProvider((_t, n) => {
      if (n === MAX_PARALLEL) t = 16_000; // first wave took 16 s: no room for another 8 s send
      return fonnteOk();
    });
    const res = await flushOutbox(env, rows.map((r) => r.id), FLUSH_LIMIT, Date.now(), { clock: () => t });
    expect(res).toEqual({ sent: MAX_PARALLEL, failed: 0, skipped: FLUSH_LIMIT - MAX_PARALLEL });
    expect(targets).toHaveLength(MAX_PARALLEL);
    const states = await Promise.all(rows.map((r) => rowOf(r.id)));
    expect(states.filter((s) => s?.status === 'SENT')).toHaveLength(MAX_PARALLEL);
    for (const s of states.filter((x) => x?.status === 'PENDING')) {
      expect(s).toMatchObject({ attempts: 0, lease_token: null, lease_until: null, next_attempt_at: null });
    }
    // Released rows are immediately claimable again.
    t = 0;
    expect((await flushOutbox(env, rows.map((r) => r.id))).sent).toBe(FLUSH_LIMIT - MAX_PARALLEL);
  });
});

describe('flushOutbox scheduling', () => {
  it('no provider config: no fetch, no attempt consumed, retried after 10 minutes', async () => {
    await setFonnte(null);
    const now = Date.now();
    const r = await insertRow();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(await flushOutbox(env, [r.id], undefined, now)).toEqual({ sent: 0, failed: 0, skipped: 1 });
    expect(fetchSpy).not.toHaveBeenCalled();
    let row = await rowOf(r.id);
    expect(row).toMatchObject({
      status: 'PENDING',
      attempts: 0,
      last_error: 'Konfigurasi WhatsApp belum lengkap.',
      lease_token: null,
      next_attempt_at: new Date(now + UNCONFIGURED_DELAY_MS).toISOString(),
    });
    // Many more flushes before the delay: still nothing consumed.
    for (let i = 0; i < 6; i++) await flushOutbox(env, [r.id], undefined, now + 1000 * i);
    expect((await rowOf(r.id))?.attempts).toBe(0);

    await setFonnte(TOKEN);
    vi.restoreAllMocks();
    stubProvider(() => fonnteOk());
    expect((await flushOutbox(env, [r.id], undefined, now + UNCONFIGURED_DELAY_MS)).sent).toBe(1);
    row = await rowOf(r.id);
    expect(row).toMatchObject({ status: 'SENT', attempts: 1, last_error: null, next_attempt_at: null });
  });

  it('undecryptable token behaves like no config (no fetch, no attempt)', async () => {
    await env.DB.prepare(`UPDATE pengaturan SET value = 'v1:AAAA:BBBB' WHERE key = 'wa.fonnte.token'`).run();
    const r = await insertRow();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(await flushOutbox(env, [r.id])).toEqual({ sent: 0, failed: 0, skipped: 1 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await rowOf(r.id)).toMatchObject({ attempts: 0, last_error: 'Konfigurasi WhatsApp belum lengkap.' });
  });

  it("'pending' skips rows not yet due and rows with attempts ≥ 5", async () => {
    const now = Date.now();
    const exhausted = await insertRow({ attempts: 5, createdAt: '2000-01-01T00:00:00.000Z' });
    const future = await insertRow({
      createdAt: '2000-01-01T00:00:00.001Z',
      nextAttemptAt: new Date(now + 60_000).toISOString(),
    });
    const due = await insertRow({ createdAt: '2000-01-01T00:00:00.002Z', nextAttemptAt: new Date(now - 1).toISOString() });
    const targets = stubProvider(() => fonnteOk());
    await flushOutbox(env, 'pending', 1, now);
    expect(targets).toEqual([due.target]);
    expect(await rowOf(exhausted.id)).toMatchObject({ status: 'PENDING', attempts: 5, lease_token: null });
    expect(await rowOf(future.id)).toMatchObject({ status: 'PENDING', attempts: 0, lease_token: null });
    expect(await rowOf(due.id)).toMatchObject({ status: 'SENT' });
  });
});
