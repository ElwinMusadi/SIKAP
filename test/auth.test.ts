import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { ApiErrorBody, ChangePasswordResponse, LoginResponse, MeResponse, SessionsResponse } from '../shared/api';
import { AUTH_POLICY } from '../shared/enums';
import { recordSuccessfulLogin } from '../server/db/akun';
import { insertSessionIfUnlocked } from '../server/db/sesi';
import { hashPassword, sha256Hex, wrapLegacySha256Hex } from '../server/lib/crypto';
import { LOGIN_IP_LIMIT } from '../server/services/auth';
import { COOKIE_NAME, call, createUser, json, login, sessionCookieFrom, uniqueIp, uniqueNip } from './helpers';

async function errorCode(res: Response): Promise<string> {
  return (await json<ApiErrorBody>(res)).error.code;
}

async function lastLog(action: string, nip: string) {
  return env.DB.prepare(
    `SELECT actor_id, actor_nip, action, result, ip FROM log_aktivitas WHERE action = ?1 AND actor_nip = ?2 ORDER BY id DESC LIMIT 1`,
  )
    .bind(action, nip)
    .first<{ actor_id: number | null; actor_nip: string; action: string; result: string; ip: string | null }>();
}

describe('POST /api/auth/login', () => {
  it('logs in with the default password, sets a hardened cookie and flags isDefaultPassword', async () => {
    const user = await createUser({ fotoR2Key: 'foto/1/x.webp' });
    const res = await call('/api/auth/login', { body: { nip: user.nip, password: user.password } });
    expect(res.status).toBe(200);

    const setCookie = res.headers.get('Set-Cookie') ?? '';
    expect(setCookie).toContain(`${COOKIE_NAME}=`);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).toMatch(/Path=\//);
    expect(setCookie).toMatch(/Max-Age=43200/);
    expect(res.headers.get('Cache-Control')).toBe('no-store');

    const body = await json<LoginResponse>(res);
    expect(body.user).toEqual({
      id: user.id,
      nip: user.nip,
      nama: expect.any(String),
      role: 'Pegawai',
      statusKepegawaian: 'PNS',
      jabatan: 'Penguji',
      fotoUrl: `/api/pegawai/${user.id}/photo`,
      isDefaultPassword: true,
    });

    const akun = await env.DB.prepare(`SELECT is_default_password, last_login_at FROM akun WHERE pegawai_id = ?1`)
      .bind(user.id)
      .first<{ is_default_password: number; last_login_at: string | null }>();
    expect(akun?.is_default_password).toBe(1);
    expect(akun?.last_login_at).not.toBeNull();

    // Only the SHA-256 of the token is stored.
    const token = sessionCookieFrom(res)!.split('=')[1]!;
    const stored = await env.DB.prepare(`SELECT token_hash FROM sesi WHERE pegawai_id = ?1`).bind(user.id).all();
    expect(stored.results).toEqual([{ token_hash: await sha256Hex(token) }]);
    expect((await lastLog('LOGIN', user.nip))?.result).toBe('SUCCESS');
  });

  it('uses the unprefixed, non-Secure cookie over plain http (localhost dev)', async () => {
    const user = await createUser();
    const res = await call('/api/auth/login', {
      base: 'http://localhost:8788',
      body: { nip: user.nip, password: user.password },
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('Set-Cookie') ?? '';
    expect(setCookie.startsWith('sikap_sid=')).toBe(true);
    expect(setCookie).not.toMatch(/Secure/i);
    const cookie = sessionCookieFrom(res, 'sikap_sid')!;
    const me = await call('/api/auth/me', { base: 'http://localhost:8788', cookie });
    expect(me.status).toBe(200);
  });

  it('reports isDefaultPassword=false for a non-default password', async () => {
    const user = await createUser({ password: 'Kuat12345' });
    const res = await call('/api/auth/login', { body: { nip: user.nip, password: 'Kuat12345' } });
    expect(res.status).toBe(200);
    expect((await json<LoginResponse>(res)).user.isDefaultPassword).toBe(false);
  });

  it('returns a generic 401 for a wrong password and counts the failure', async () => {
    const user = await createUser();
    const res = await call('/api/auth/login', { body: { nip: user.nip, password: 'salah' } });
    expect(res.status).toBe(401);
    const body = await json<ApiErrorBody>(res);
    expect(body.error).toEqual({ code: 'INVALID_CREDENTIALS', message: 'NIP atau password salah.' });
    const akun = await env.DB.prepare(`SELECT failed_attempts FROM akun WHERE pegawai_id = ?1`)
      .bind(user.id)
      .first<{ failed_attempts: number }>();
    expect(akun?.failed_attempts).toBe(1);
    const log = await lastLog('LOGIN_FAILED', user.nip);
    expect(log).toMatchObject({ actor_id: user.id, result: 'FAILURE' });
  });

  it('returns the identical 401 for an unknown NIP and logs it without actor_id', async () => {
    const nip = uniqueNip();
    const res = await call('/api/auth/login', { body: { nip, password: 'apa saja' } });
    expect(res.status).toBe(401);
    expect((await json<ApiErrorBody>(res)).error).toEqual({
      code: 'INVALID_CREDENTIALS',
      message: 'NIP atau password salah.',
    });
    expect(await lastLog('LOGIN_FAILED', nip)).toMatchObject({ actor_id: null, actor_nip: nip, result: 'FAILURE' });
  });

  it('never stores non-NIP input in the audit log (users type passwords into the NIP field)', async () => {
    const typed = 'MyS3cretPassw0rd';
    const res = await call('/api/auth/login', { body: { nip: typed, password: 'x' } });
    expect(res.status).toBe(401);
    expect(await lastLog('LOGIN_FAILED', `<invalid:${typed.length}>`)).toMatchObject({ actor_id: null });
    const leaked = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM log_aktivitas WHERE actor_nip LIKE ?1 OR target_id LIKE ?1 OR description LIKE ?1`,
    )
      .bind(`%${typed}%`)
      .first<{ n: number }>();
    expect(leaked?.n).toBe(0);
  });

  it('10 parallel wrong guesses run at most 5 password verifications and lock the account', async () => {
    const user = await createUser();
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        call('/api/auth/login', { body: { nip: user.nip, password: `salah-${i}` } }),
      ),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 401).length).toBeLessThanOrEqual(AUTH_POLICY.maxFailedAttempts - 1);
    expect(statuses.every((s) => s === 401 || s === 423)).toBe(true);
    expect(statuses.filter((s) => s === 423).length).toBeGreaterThanOrEqual(10 - (AUTH_POLICY.maxFailedAttempts - 1));

    // Each real PBKDF2 verification of a wrong password writes exactly one 'Password salah' row.
    const verified = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM log_aktivitas WHERE actor_id = ?1 AND action = 'LOGIN_FAILED' AND description = 'Password salah'`,
    )
      .bind(user.id)
      .first<{ n: number }>();
    expect(verified!.n).toBeLessThanOrEqual(AUTH_POLICY.maxFailedAttempts);

    const akun = await env.DB.prepare(`SELECT locked_until FROM akun WHERE pegawai_id = ?1`)
      .bind(user.id)
      .first<{ locked_until: string | null }>();
    expect(akun!.locked_until! > new Date().toISOString()).toBe(true);

    const correct = await call('/api/auth/login', { body: { nip: user.nip, password: user.password } });
    expect(correct.status).toBe(423);
    const sessions = await env.DB.prepare(`SELECT COUNT(*) AS n FROM sesi WHERE pegawai_id = ?1`)
      .bind(user.id)
      .first<{ n: number }>();
    expect(sessions?.n).toBe(0);
  });

  it('success writes cannot clear a lock set concurrently (conditional UPDATE/INSERT)', async () => {
    const user = await createUser();
    const now = new Date().toISOString();
    const until = new Date(Date.now() + 15 * 60_000).toISOString();
    await env.DB.prepare(`UPDATE akun SET failed_attempts = 5, locked_until = ?2 WHERE pegawai_id = ?1`)
      .bind(user.id, until)
      .run();
    const out = await env.DB.batch([
      recordSuccessfulLogin(env.DB, user.id, now, true, null),
      insertSessionIfUnlocked(env.DB, {
        tokenHash: 'f'.repeat(64),
        pegawaiId: user.id,
        nowIso: now,
        expiresIso: until,
        ip: null,
        userAgent: null,
      }),
    ]);
    expect(out[0]?.meta.changes).toBe(0);
    expect(out[1]?.meta.changes).toBe(0);
    const akun = await env.DB.prepare(`SELECT failed_attempts, locked_until FROM akun WHERE pegawai_id = ?1`)
      .bind(user.id)
      .first();
    expect(akun).toEqual({ failed_attempts: 5, locked_until: until });
  });

  it('locks the account after 5 failures (423 with retryAfterSeconds) even for the right password', async () => {
    const user = await createUser();
    const ip = uniqueIp();
    for (let i = 1; i < AUTH_POLICY.maxFailedAttempts; i++) {
      const r = await call('/api/auth/login', { body: { nip: user.nip, password: `salah${i}` }, ip });
      expect(r.status).toBe(401);
    }
    const fifth = await call('/api/auth/login', { body: { nip: user.nip, password: 'salah5' }, ip });
    expect(fifth.status).toBe(423);
    const body = await json<ApiErrorBody>(fifth);
    expect(body.error.code).toBe('ACCOUNT_LOCKED');
    expect(body.error.retryAfterSeconds).toBeGreaterThan(14 * 60);
    expect(body.error.retryAfterSeconds).toBeLessThanOrEqual(15 * 60);
    expect(fifth.headers.get('Retry-After')).toBe(String(body.error.retryAfterSeconds));

    const correct = await call('/api/auth/login', { body: { nip: user.nip, password: user.password }, ip });
    expect(correct.status).toBe(423);
    expect(await errorCode(correct)).toBe('ACCOUNT_LOCKED');
  });

  it('unlocks after the lock expires and resets the counter on success', async () => {
    const user = await createUser();
    const past = new Date(Date.now() - 60_000).toISOString();
    await env.DB.prepare(`UPDATE akun SET failed_attempts = 5, locked_until = ?2 WHERE pegawai_id = ?1`)
      .bind(user.id, past)
      .run();

    // Expired lock + wrong password restarts the counter at 1 (not locked again).
    const wrong = await call('/api/auth/login', { body: { nip: user.nip, password: 'salah' } });
    expect(wrong.status).toBe(401);
    let akun = await env.DB.prepare(`SELECT failed_attempts, locked_until FROM akun WHERE pegawai_id = ?1`)
      .bind(user.id)
      .first<{ failed_attempts: number; locked_until: string | null }>();
    expect(akun).toEqual({ failed_attempts: 1, locked_until: null });

    const ok = await call('/api/auth/login', { body: { nip: user.nip, password: user.password } });
    expect(ok.status).toBe(200);
    akun = await env.DB.prepare(`SELECT failed_attempts, locked_until FROM akun WHERE pegawai_id = ?1`)
      .bind(user.id)
      .first();
    expect(akun).toEqual({ failed_attempts: 0, locked_until: null });
  });

  it('rejects a Nonaktif account with 403 ACCOUNT_INACTIVE only after the correct password', async () => {
    const user = await createUser({ statusAkun: 'Nonaktif' });
    const wrong = await call('/api/auth/login', { body: { nip: user.nip, password: 'salah' } });
    expect(wrong.status).toBe(401);
    const res = await call('/api/auth/login', { body: { nip: user.nip, password: user.password } });
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe('ACCOUNT_INACTIVE');
    expect(res.headers.get('Set-Cookie')).toBeNull();
  });

  it('does not let a soft-deleted pegawai log in', async () => {
    const user = await createUser({ deleted: true });
    const res = await call('/api/auth/login', { body: { nip: user.nip, password: user.password } });
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe('INVALID_CREDENTIALS');
  });

  it('accepts a migrated legacy-wrap hash without re-hashing it (saves one PBKDF2)', async () => {
    const nip = uniqueNip();
    const legacy = await wrapLegacySha256Hex(await sha256Hex('Lama12345'), env.PASSWORD_PEPPER);
    const user = await createUser({ nip, password: 'Lama12345', passwordHash: legacy });
    await login(user);
    const akun = await env.DB.prepare(`SELECT password_hash FROM akun WHERE pegawai_id = ?1`)
      .bind(user.id)
      .first<{ password_hash: string }>();
    expect(akun?.password_hash).toBe(legacy);
    await login(user);
  });

  it('re-hashes hashes weaker than policy on login', async () => {
    const weak = await hashPassword('Lemah12345', env.PASSWORD_PEPPER, 1000);
    const user = await createUser({ password: 'Lemah12345', passwordHash: weak });
    await login(user);
    const akun = await env.DB.prepare(`SELECT password_hash FROM akun WHERE pegawai_id = ?1`)
      .bind(user.id)
      .first<{ password_hash: string }>();
    expect(akun?.password_hash.startsWith('pbkdf2-sha256$10000$')).toBe(true);
    await login(user);
  });

  it('rejects bodies over 16 KB with 400 VALIDATION_ERROR', async () => {
    const res = await call('/api/auth/login', { body: { nip: '1', password: 'x'.repeat(17 * 1024) } });
    expect(res.status).toBe(400);
    expect((await json<ApiErrorBody>(res)).error).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'Ukuran permintaan terlalu besar.',
    });
  });

  it('validates the body (400 with fields) and rejects malformed JSON', async () => {
    const res = await call('/api/auth/login', { body: { nip: '', password: '' } });
    expect(res.status).toBe(400);
    const body = await json<ApiErrorBody>(res);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.fields).toMatchObject({ nip: 'NIP wajib diisi.', password: 'Password wajib diisi.' });

    const raw = await env.DB.prepare('SELECT 1').first(); // keep DB warm
    expect(raw).not.toBeNull();
    const { app } = await import('../server/app');
    const bad = await app.request(
      'https://sikap.test/api/auth/login',
      { method: 'POST', headers: { Origin: 'https://sikap.test', 'Content-Type': 'application/json' }, body: '{' },
      env,
    );
    expect(bad.status).toBe(400);
    expect(await errorCode(bad)).toBe('VALIDATION_ERROR');
  });

  it('throttles an IP after too many attempts (429 RATE_LIMITED) without touching the account', async () => {
    const ip = uniqueIp();
    const windowStart = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO rate_limit (key, window_start, count) VALUES (?1, ?2, ?3)`)
      .bind(`login-ip:${ip}`, windowStart, LOGIN_IP_LIMIT.maxAttempts)
      .run();
    const user = await createUser();
    const res = await call('/api/auth/login', { body: { nip: user.nip, password: user.password }, ip });
    expect(res.status).toBe(429);
    const body = await json<ApiErrorBody>(res);
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.error.retryAfterSeconds).toBeGreaterThan(0);
    const akun = await env.DB.prepare(`SELECT failed_attempts FROM akun WHERE pegawai_id = ?1`)
      .bind(user.id)
      .first<{ failed_attempts: number }>();
    expect(akun?.failed_attempts).toBe(0);

    // A different IP is unaffected.
    const other = await call('/api/auth/login', { body: { nip: user.nip, password: user.password } });
    expect(other.status).toBe(200);
  });

  it('IP throttle holds under parallel requests (decided from the atomic UPSERT)', async () => {
    const ip = uniqueIp();
    await env.DB.prepare(`INSERT INTO rate_limit (key, window_start, count) VALUES (?1, ?2, ?3)`)
      .bind(`login-ip:${ip}`, new Date().toISOString(), LOGIN_IP_LIMIT.maxAttempts - 3)
      .run();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => call('/api/auth/login', { body: { nip: uniqueNip(), password: 'x' }, ip })),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 401)).toHaveLength(3);
    expect(statuses.filter((s) => s === 429)).toHaveLength(7);
  });

  it('refunds the IP hit on successful login', async () => {
    const ip = uniqueIp();
    const user = await createUser();
    await call('/api/auth/login', { body: { nip: user.nip, password: 'salah' }, ip });
    await login(user, user.password, ip);
    const row = await env.DB.prepare(`SELECT count FROM rate_limit WHERE key = ?1`)
      .bind(`login-ip:${ip}`)
      .first<{ count: number }>();
    expect(row?.count).toBe(1);
  });

  it('starts a new IP window after expiry', async () => {
    const ip = uniqueIp();
    const old = new Date(Date.now() - (LOGIN_IP_LIMIT.windowMinutes + 1) * 60_000).toISOString();
    await env.DB.prepare(`INSERT INTO rate_limit (key, window_start, count) VALUES (?1, ?2, 999)`)
      .bind(`login-ip:${ip}`, old)
      .run();
    const res = await call('/api/auth/login', { body: { nip: uniqueNip(), password: 'x' }, ip });
    expect(res.status).toBe(401);
    const row = await env.DB.prepare(`SELECT count, window_start FROM rate_limit WHERE key = ?1`)
      .bind(`login-ip:${ip}`)
      .first<{ count: number; window_start: string }>();
    expect(row?.count).toBe(1);
    expect(row!.window_start > old).toBe(true);
  });
});

describe('CSRF / Origin check', () => {
  it('rejects unsafe requests without Origin', async () => {
    const user = await createUser();
    const res = await call('/api/auth/login', { body: { nip: user.nip, password: user.password }, origin: null });
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe('CSRF_REJECTED');
  });

  it('rejects the opaque `Origin: null` (sandboxed iframes, file://)', async () => {
    const user = await createUser();
    const res = await call('/api/auth/login', { body: { nip: user.nip, password: user.password }, origin: 'null' });
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe('CSRF_REJECTED');
  });

  it('rejects a foreign Origin', async () => {
    const user = await createUser();
    const res = await call('/api/auth/login', {
      body: { nip: user.nip, password: user.password },
      origin: 'https://evil.example',
    });
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe('CSRF_REJECTED');
  });

  it('accepts APP_URL origin even when the request host differs (e.g. proxied preview)', async () => {
    const user = await createUser();
    const res = await call('/api/auth/login', {
      base: 'https://abc123.sikap.pages.dev',
      origin: env.APP_URL,
      body: { nip: user.nip, password: user.password },
    });
    expect(res.status).toBe(200);
  });

  it('does not require Origin for GET', async () => {
    const res = await call('/api/health', { origin: null });
    expect(res.status).toBe(200);
  });
});

describe('session middleware', () => {
  it('GET /api/auth/me without cookie → 401 SESSION_EXPIRED', async () => {
    const res = await call('/api/auth/me');
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe('SESSION_EXPIRED');
  });

  it('GET /api/auth/me with a garbage cookie → 401 and clears the cookie', async () => {
    const res = await call('/api/auth/me', { cookie: `${COOKIE_NAME}=not-a-token` });
    expect(res.status).toBe(401);
    expect(res.headers.get('Set-Cookie')).toMatch(/Max-Age=0/);
  });

  it('returns the current user', async () => {
    const user = await createUser({ role: 'Admin' });
    const cookie = await login(user);
    const res = await call('/api/auth/me', { cookie });
    expect(res.status).toBe(200);
    const body = await json<MeResponse>(res);
    expect(body.user).toMatchObject({ id: user.id, nip: user.nip, role: 'Admin', fotoUrl: null, isDefaultPassword: true });
  });

  it('rejects an expired session', async () => {
    const user = await createUser();
    const cookie = await login(user);
    const past = new Date(Date.now() - 1000).toISOString();
    await env.DB.prepare(`UPDATE sesi SET expires_at = ?2 WHERE pegawai_id = ?1`).bind(user.id, past).run();
    const res = await call('/api/auth/me', { cookie });
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe('SESSION_EXPIRED');
  });

  it('invalidates sessions of a deactivated or deleted user immediately', async () => {
    const a = await createUser();
    const b = await createUser();
    const ca = await login(a);
    const cb = await login(b);
    await env.DB.prepare(`UPDATE pegawai SET status_akun = 'Nonaktif' WHERE id = ?1`).bind(a.id).run();
    const now = new Date().toISOString();
    await env.DB.prepare(`UPDATE pegawai SET deleted_at = ?2, purge_after = ?2 WHERE id = ?1`).bind(b.id, now).run();
    expect((await call('/api/auth/me', { cookie: ca })).status).toBe(401);
    expect((await call('/api/auth/me', { cookie: cb })).status).toBe(401);
  });

  it('slides expiry with at most one write per touch interval', async () => {
    const user = await createUser();
    const cookie = await login(user);
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    const soon = new Date(Date.now() + 60_000).toISOString();
    await env.DB.prepare(`UPDATE sesi SET last_seen_at = ?2, expires_at = ?3 WHERE pegawai_id = ?1`)
      .bind(user.id, old, soon)
      .run();

    const res = await call('/api/auth/me', { cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get('Set-Cookie')).toMatch(/Max-Age=43200/);
    const row = await env.DB.prepare(`SELECT last_seen_at, expires_at FROM sesi WHERE pegawai_id = ?1`)
      .bind(user.id)
      .first<{ last_seen_at: string; expires_at: string }>();
    expect(row!.last_seen_at > old).toBe(true);
    expect(Date.parse(row!.expires_at)).toBeGreaterThan(Date.now() + 11 * 3_600_000);

    // Fresh session → no write, no cookie refresh.
    const again = await call('/api/auth/me', { cookie });
    expect(again.headers.get('Set-Cookie')).toBeNull();
    const row2 = await env.DB.prepare(`SELECT last_seen_at FROM sesi WHERE pegawai_id = ?1`)
      .bind(user.id)
      .first<{ last_seen_at: string }>();
    expect(row2!.last_seen_at).toBe(row!.last_seen_at);
  });
});

describe('POST /api/auth/logout', () => {
  it('deletes the session, clears the cookie and logs LOGOUT', async () => {
    const user = await createUser();
    const cookie = await login(user);
    const res = await call('/api/auth/logout', { method: 'POST', cookie });
    expect(res.status).toBe(204);
    expect(res.headers.get('Set-Cookie')).toMatch(/Max-Age=0/);
    expect((await call('/api/auth/me', { cookie })).status).toBe(401);
    expect((await lastLog('LOGOUT', user.nip))?.result).toBe('SUCCESS');
  });

  it('requires a session', async () => {
    const res = await call('/api/auth/logout', { method: 'POST' });
    expect(res.status).toBe(401);
  });
});

describe('POST /api/auth/change-password', () => {
  const NEW_PW = 'BaruKuat123';

  it('rejects a wrong current password with 400 fields.currentPassword and logs FAILURE', async () => {
    const user = await createUser();
    const cookie = await login(user);
    const res = await call('/api/auth/change-password', {
      cookie,
      body: { currentPassword: 'salah', newPassword: NEW_PW, confirmPassword: NEW_PW },
    });
    expect(res.status).toBe(400);
    const body = await json<ApiErrorBody>(res);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.fields).toEqual({ currentPassword: 'Password saat ini salah.' });
    expect((await lastLog('PASSWORD_CHANGE', user.nip))?.result).toBe('FAILURE');
  });

  it('enforces the new-password policy (incl. not the default password)', async () => {
    const user = await createUser();
    const cookie = await login(user);
    const res = await call('/api/auth/change-password', {
      cookie,
      body: { currentPassword: user.password, newPassword: 'lemah', confirmPassword: 'beda' },
    });
    expect(res.status).toBe(400);
    const fields = (await json<ApiErrorBody>(res)).error.fields ?? {};
    expect(Object.keys(fields)).toContain('newPassword');
  });

  it('changes the password, clears isDefaultPassword and revokes other sessions', async () => {
    const user = await createUser();
    const current = await login(user);
    await login(user);
    await login(user);

    const res = await call('/api/auth/change-password', {
      cookie: current,
      body: { currentPassword: user.password, newPassword: NEW_PW, confirmPassword: NEW_PW },
    });
    expect(res.status).toBe(200);
    const body = await json<ChangePasswordResponse>(res);
    expect(body.revokedSessions).toBe(2);
    expect(body.user.isDefaultPassword).toBe(false);

    const akun = await env.DB.prepare(`SELECT is_default_password, password_changed_at FROM akun WHERE pegawai_id = ?1`)
      .bind(user.id)
      .first<{ is_default_password: number; password_changed_at: string | null }>();
    expect(akun?.is_default_password).toBe(0);
    expect(akun?.password_changed_at).not.toBeNull();

    const sessions = await env.DB.prepare(`SELECT COUNT(*) AS n FROM sesi WHERE pegawai_id = ?1`)
      .bind(user.id)
      .first<{ n: number }>();
    expect(sessions?.n).toBe(1);
    expect((await call('/api/auth/me', { cookie: current })).status).toBe(200);
    expect((await json<MeResponse>(await call('/api/auth/me', { cookie: current }))).user.isDefaultPassword).toBe(false);

    // Old password no longer works, new one does.
    const old = await call('/api/auth/login', { body: { nip: user.nip, password: user.password } });
    expect(old.status).toBe(401);
    await login(user, NEW_PW);
    expect((await lastLog('PASSWORD_CHANGE', user.nip))?.result).toBe('SUCCESS');
  });

  it('wrong currentPassword counts toward lockout: 5th failure → 423, all sessions revoked, cookie cleared', async () => {
    const user = await createUser();
    const current = await login(user);
    const other = await login(user);
    const wrongBody = { currentPassword: 'salah', newPassword: NEW_PW, confirmPassword: NEW_PW };

    for (let i = 1; i < AUTH_POLICY.maxFailedAttempts; i++) {
      const r = await call('/api/auth/change-password', { cookie: current, body: wrongBody });
      expect(r.status).toBe(400);
    }
    const fifth = await call('/api/auth/change-password', { cookie: current, body: wrongBody });
    expect(fifth.status).toBe(423);
    const body = await json<ApiErrorBody>(fifth);
    expect(body.error.code).toBe('ACCOUNT_LOCKED');
    expect(body.error.retryAfterSeconds).toBeGreaterThan(14 * 60);
    expect(fifth.headers.get('Set-Cookie')).toMatch(/Max-Age=0/);

    const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM sesi WHERE pegawai_id = ?1`)
      .bind(user.id)
      .first<{ n: number }>();
    expect(n?.n).toBe(0);
    expect((await call('/api/auth/me', { cookie: current })).status).toBe(401);
    expect((await call('/api/auth/me', { cookie: other })).status).toBe(401);
    expect((await lastLog('ACCOUNT_LOCKED', user.nip))?.result).toBe('WARNING');

    // Locked: login refused, even with the right password.
    const relogin = await call('/api/auth/login', { body: { nip: user.nip, password: user.password } });
    expect(relogin.status).toBe(423);
  });

  it('change-password while locked → 423 without hashing; correct password resets the counter', async () => {
    const user = await createUser();
    const cookie = await login(user);
    // Two wrong attempts, then a correct change resets the counter.
    const wrongBody = { currentPassword: 'salah', newPassword: NEW_PW, confirmPassword: NEW_PW };
    await call('/api/auth/change-password', { cookie, body: wrongBody });
    await call('/api/auth/change-password', { cookie, body: wrongBody });
    const ok = await call('/api/auth/change-password', {
      cookie,
      body: { currentPassword: user.password, newPassword: NEW_PW, confirmPassword: NEW_PW },
    });
    expect(ok.status).toBe(200);
    const akun = await env.DB.prepare(`SELECT failed_attempts FROM akun WHERE pegawai_id = ?1`)
      .bind(user.id)
      .first<{ failed_attempts: number }>();
    expect(akun?.failed_attempts).toBe(0);

    // Lock it directly; the session itself stays valid but change-password is refused.
    const until = new Date(Date.now() + 10 * 60_000).toISOString();
    await env.DB.prepare(`UPDATE akun SET failed_attempts = 5, locked_until = ?2 WHERE pegawai_id = ?1`)
      .bind(user.id, until)
      .run();
    const locked = await call('/api/auth/change-password', {
      cookie,
      body: { currentPassword: NEW_PW, newPassword: 'LainLagi123', confirmPassword: 'LainLagi123' },
    });
    expect(locked.status).toBe(423);
    const after = await env.DB.prepare(`SELECT failed_attempts, locked_until FROM akun WHERE pegawai_id = ?1`)
      .bind(user.id)
      .first();
    expect(after).toEqual({ failed_attempts: 5, locked_until: until });
  });

  it('keeps other sessions when revokeOtherSessions=false', async () => {
    const user = await createUser();
    const current = await login(user);
    const other = await login(user);
    const res = await call('/api/auth/change-password', {
      cookie: current,
      body: { currentPassword: user.password, newPassword: NEW_PW, confirmPassword: NEW_PW, revokeOtherSessions: false },
    });
    expect(res.status).toBe(200);
    expect((await json<ChangePasswordResponse>(res)).revokedSessions).toBe(0);
    expect((await call('/api/auth/me', { cookie: other })).status).toBe(200);
  });
});

describe('session management', () => {
  it('lists own sessions with a current flag and revokes one by id', async () => {
    const user = await createUser();
    const intruder = await createUser();
    const current = await login(user);
    const other = await login(user);
    const intruderCookie = await login(intruder);

    const res = await call('/api/auth/sessions', { cookie: current });
    expect(res.status).toBe(200);
    const { sessions } = await json<SessionsResponse>(res);
    expect(sessions).toHaveLength(2);
    expect(sessions.filter((s) => s.current)).toHaveLength(1);
    for (const s of sessions) expect(s.id).toMatch(/^[0-9a-f]{16}$/);
    const otherId = sessions.find((s) => !s.current)!.id;
    const currentId = sessions.find((s) => s.current)!.id;

    // Cannot revoke the current session via this endpoint.
    const self = await call(`/api/auth/sessions/${currentId}`, { method: 'DELETE', cookie: current });
    expect(self.status).toBe(400);

    // Cannot revoke someone else's session.
    const foreign = await call(`/api/auth/sessions/${otherId}`, { method: 'DELETE', cookie: intruderCookie });
    expect(foreign.status).toBe(404);
    // changes()-gated audit insert: the failed revoke left no SESSION_REVOKE row.
    const revokeLogs = () =>
      env.DB.prepare(`SELECT actor_id FROM log_aktivitas WHERE action = 'SESSION_REVOKE' AND target_id = ?1`)
        .bind(otherId)
        .all<{ actor_id: number }>();
    expect((await revokeLogs()).results).toHaveLength(0);

    const bad = await call(`/api/auth/sessions/not-hex`, { method: 'DELETE', cookie: current });
    expect(bad.status).toBe(404);

    const del = await call(`/api/auth/sessions/${otherId}`, { method: 'DELETE', cookie: current });
    expect(del.status).toBe(200);
    expect(await json(del)).toEqual({ revoked: 1 });
    expect((await revokeLogs()).results).toEqual([{ actor_id: user.id }]);
    expect((await call('/api/auth/me', { cookie: other })).status).toBe(401);
    expect((await call('/api/auth/me', { cookie: current })).status).toBe(200);
  });

  it('revoke-others keeps only the current session', async () => {
    const user = await createUser();
    const current = await login(user);
    const o1 = await login(user);
    const o2 = await login(user);
    const res = await call('/api/auth/sessions/revoke-others', { method: 'POST', cookie: current });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ revoked: 2 });
    expect((await call('/api/auth/me', { cookie: o1 })).status).toBe(401);
    expect((await call('/api/auth/me', { cookie: o2 })).status).toBe(401);
    expect((await call('/api/auth/me', { cookie: current })).status).toBe(200);
    const list = await json<SessionsResponse>(await call('/api/auth/sessions', { cookie: current }));
    expect(list.sessions).toHaveLength(1);
  });
});

describe('misc', () => {
  it('GET /api/health', async () => {
    const res = await call('/api/health');
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toMatchObject({ status: 'ok', db: 'ok' });
    expect(typeof body.time).toBe('string');
  });

  it('unknown /api routes → 404 JSON', async () => {
    const res = await call('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ error: { code: 'NOT_FOUND', message: expect.any(String) } });
  });
});
