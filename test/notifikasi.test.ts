import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotifSettings, TestWhatsAppResponse, WhatsAppSettings } from '../shared/verifikasi';
import { decryptSetting, encryptSetting } from '../server/lib/secrets';
import { sanitizeDetail, sendWhatsApp } from '../server/lib/whatsapp';
import {
  clearDeferredTasks,
  FLUSH_LIMIT,
  flushOutbox,
  outboxStatements,
  runDeferredTasks,
  uploadGuard,
} from '../server/services/notifikasi';
import { call, json } from './helpers';
import { fonnteOk, mockFetch, person, putDoc, setNotif, uniquePhone } from './phase5-helpers';

const FONNTE_TOKEN = 'fonnte-secret-token-ABCD';

async function outboxFor(target: string) {
  return (
    await env.DB.prepare(`SELECT * FROM notifikasi_outbox WHERE target = ?1 ORDER BY id`).bind(target).all<Record<string, unknown>>()
  ).results;
}

async function insertOutbox(target: string, attempts = 0): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO notifikasi_outbox (target, template, params, attempts, created_at)
     VALUES (?1, 'dokumen_terverifikasi', '{"nama":"Budi","namaDokumen":"KTP"}', ?2, ?3) RETURNING id`,
  )
    .bind(target, attempts, new Date().toISOString())
    .first<{ id: number }>();
  return row!.id;
}

async function configureFonnte(): Promise<void> {
  const admin = await person({ role: 'Admin' });
  const res = await call('/api/admin/settings/whatsapp', {
    method: 'PUT',
    cookie: admin.cookie,
    body: { provider: 'fonnte', fonnteToken: FONNTE_TOKEN },
  });
  expect(res.status).toBe(200);
}

beforeEach(() => clearDeferredTasks());
afterEach(async () => {
  vi.restoreAllMocks();
  await setNotif({ dokumenBaru: true, dokumenApproved: true, dokumenRejected: true });
});

describe('secrets + sanitizeDetail', () => {
  it('round-trips with a fresh IV and rejects tampering', async () => {
    const a = await encryptSetting('hello', env.SETTINGS_ENC_KEY);
    const b = await encryptSetting('hello', env.SETTINGS_ENC_KEY);
    expect(a).toMatch(/^v1:[^:]+:[^:]+$/);
    expect(a).not.toBe(b);
    expect(await decryptSetting(a, env.SETTINGS_ENC_KEY)).toBe('hello');
    const parts = a.split(':');
    const tampered = `${parts[0]}:${parts[1]}:${btoa('x'.repeat(30))}`;
    await expect(decryptSetting(tampered, env.SETTINGS_ENC_KEY)).rejects.toThrow();
  });

  it('masks digit runs ≥ 6 and truncates', () => {
    expect(sanitizeDetail('target 6281234567890 invalid, code 12345')).toBe('target *** invalid, code 12345');
    expect(sanitizeDetail('x'.repeat(500)).length).toBeLessThanOrEqual(200);
  });
});

describe('sendWhatsApp', () => {
  it('fonnte: form body + Authorization header; success needs status true', async () => {
    const calls = mockFetch(() => fonnteOk());
    const res = await sendWhatsApp({ provider: 'fonnte', token: 'tok', appUrl: 'https://sikap.test' }, '628111', 'dokumen_ditolak', {
      nama: 'Budi',
      namaDokumen: 'KTP',
      alasan: 'Buram',
    });
    expect(res.ok).toBe(true);
    expect(calls[0]!.url).toBe('https://api.fonnte.com/send');
    expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe('tok');
    const form = new URLSearchParams(calls[0]!.init!.body as string);
    expect(form.get('target')).toBe('628111');
    expect(form.get('countryCode')).toBe('62');
    expect(form.get('message')).toContain('Alasan: _Buram_');
    expect(form.get('message')).toContain('https://sikap.test');

    vi.restoreAllMocks();
    mockFetch(() => new Response(JSON.stringify({ status: false, reason: 'token invalid' }), { status: 200 }));
    const bad = await sendWhatsApp({ provider: 'fonnte', token: 'tok', appUrl: 'x' }, '628111', 'test', { nama: 'A' });
    // Classified into a fixed phrase; the provider's own text is never kept.
    expect(bad).toEqual({ ok: false, status: 200, detail: 'HTTP 200: Fonnte: token tidak valid.' });
  });

  it('fonnte failures: generic detail only, even when the provider echoes the token', async () => {
    const secret = 'Zx9SecretKeyQwerty77';
    const cfg = { provider: 'fonnte' as const, token: secret, appUrl: 'x' };
    const cases: [Response, string][] = [
      [
        new Response(JSON.stringify({ status: false, reason: `invalid token ${secret} for 6281234567890` }), { status: 200 }),
        'HTTP 200: Fonnte: token tidak valid.',
      ],
      [new Response(JSON.stringify({ status: false, reason: `weird ${secret}` }), { status: 200 }), 'HTTP 200: Fonnte menolak pesan.'],
      [new Response(`Unauthorized: ${secret}`, { status: 401 }), 'HTTP 401: Token Fonnte tidak valid atau kedaluwarsa.'],
      [new Response(`<html>${secret}</html>`, { status: 502 }), 'HTTP 502: Layanan Fonnte sedang bermasalah.'],
      [new Response(`not json ${secret}`, { status: 200 }), 'HTTP 200: Respons penyedia WhatsApp tidak dikenali.'],
    ];
    for (const [response, expected] of cases) {
      vi.restoreAllMocks();
      mockFetch(() => response);
      const res = await sendWhatsApp(cfg, '628111', 'test', { nama: 'A' });
      expect(res).toEqual({ ok: false, status: response.status, detail: expected });
      expect(JSON.stringify(res)).not.toContain(secret);
    }
  });

  it('fonnte: an oversized success body is not read to the end and is not trusted', async () => {
    mockFetch(() => new Response(`{"status":true,"pad":"${'a'.repeat(20 * 1024)}"}`, { status: 200 }));
    const res = await sendWhatsApp({ provider: 'fonnte', token: 't', appUrl: 'x' }, '628', 'test', { nama: 'A' });
    expect(res).toEqual({ ok: false, status: 200, detail: 'HTTP 200: Respons penyedia WhatsApp tidak dikenali.' });
  });

  it('meta failures: generic detail by HTTP status, provider message discarded', async () => {
    const secret = 'EAAGsecretMetaToken123abc';
    const cfg = { provider: 'meta' as const, token: secret, phoneId: '1234567', appUrl: 'x' };
    const body = (msg: string) => JSON.stringify({ error: { message: msg, type: 'OAuthException', code: 190 } });
    const cases: [number, string][] = [
      [400, 'HTTP 400: Meta menolak permintaan (data/template tidak valid).'],
      [401, 'HTTP 401: Token Meta tidak valid atau kedaluwarsa.'],
      [404, 'HTTP 404: Phone Number ID tidak ditemukan.'],
      [429, 'HTTP 429: Batas pengiriman Meta tercapai.'],
      [500, 'HTTP 500: Layanan Meta sedang bermasalah.'],
    ];
    for (const [status, expected] of cases) {
      vi.restoreAllMocks();
      mockFetch(() => new Response(body(`Invalid OAuth access token ${secret} for 6281234567890`), { status }));
      const res = await sendWhatsApp(cfg, '628222', 'dokumen_terverifikasi', { nama: 'A', namaDokumen: 'B' });
      expect(res).toEqual({ ok: false, status, detail: expected });
      expect(JSON.stringify(res)).not.toContain(secret);
    }
  });

  it('meta: template payload with positional parameters; test uses text', async () => {
    const calls = mockFetch(() => new Response('{"messages":[{"id":"x"}]}', { status: 200 }));
    const cfg = { provider: 'meta' as const, token: 'mt', phoneId: '1234567', appUrl: 'https://sikap.test' };
    expect((await sendWhatsApp(cfg, '628222', 'dokumen_baru_admin', { namaPegawai: 'Ani', namaDokumen: 'SK' })).ok).toBe(true);
    expect(calls[0]!.url).toBe('https://graph.facebook.com/v21.0/1234567/messages');
    expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe('Bearer mt');
    const payload = JSON.parse(calls[0]!.init!.body as string);
    expect(payload).toMatchObject({
      messaging_product: 'whatsapp',
      to: '628222',
      type: 'template',
      template: { name: 'dokumen_baru_admin', language: { code: 'id' } },
    });
    expect(payload.template.components[0].parameters).toEqual([
      { type: 'text', text: 'Ani' },
      { type: 'text', text: 'SK' },
    ]);
    await sendWhatsApp(cfg, '628222', 'test', { nama: 'Ani' });
    const t = JSON.parse(calls[1]!.init!.body as string);
    expect(t.type).toBe('text');
    expect(typeof t.text.body).toBe('string');
  });

  it('network errors become ok:false without throwing', async () => {
    mockFetch(() => {
      throw new TypeError('connect failed to 10.0.0.123456');
    });
    const res = await sendWhatsApp({ provider: 'fonnte', token: 't', appUrl: 'x' }, '628', 'test', { nama: 'A' });
    expect(res).toEqual({ ok: false, status: undefined, detail: 'Gagal menghubungi penyedia WhatsApp.' });
  });
});

describe('flushOutbox', () => {
  it('marks SENT on provider success', async () => {
    await configureFonnte();
    const target = uniquePhone();
    const id = await insertOutbox(target);
    const calls = mockFetch(() => fonnteOk());
    const r = await flushOutbox(env, [id]);
    expect(r.sent).toBe(1);
    expect(calls).toHaveLength(1);
    const [row] = await outboxFor(target);
    expect(row).toMatchObject({ status: 'SENT', attempts: 1, last_error: null });
    expect(row?.sent_at).toBeTruthy();
    // Already sent: a second flush does nothing.
    expect((await flushOutbox(env, [id])).sent).toBe(0);
  });

  it('failure → attempts+1, generic last_error, backoff; 5th failure → FAILED', async () => {
    await configureFonnte();
    const target = uniquePhone();
    const id = await insertOutbox(target);
    const calls = mockFetch(
      () => new Response(JSON.stringify({ status: false, reason: `invalid target ${target}` }), { status: 200 }),
    );
    let now = Date.now();
    expect(await flushOutbox(env, [id], undefined, now)).toEqual({ sent: 0, failed: 1, skipped: 0 });
    let [row] = await outboxFor(target);
    expect(row).toMatchObject({ status: 'PENDING', attempts: 1, last_error: 'HTTP 200: Fonnte: nomor tujuan tidak valid.' });
    expect(row).toMatchObject({ lease_token: null, lease_until: null });
    expect(Date.parse(String(row?.next_attempt_at))).toBeGreaterThan(now);

    // Not due yet: an immediate retry neither sends nor consumes an attempt.
    expect(await flushOutbox(env, [id], undefined, now + 1000)).toEqual({ sent: 0, failed: 0, skipped: 0 });
    expect(calls).toHaveLength(1);

    for (let i = 0; i < 4; i++) {
      now += 2 * 3_600_000; // past every backoff step
      await flushOutbox(env, [id], undefined, now);
    }
    [row] = await outboxFor(target);
    expect(row).toMatchObject({ status: 'FAILED', attempts: 5, next_attempt_at: null, lease_token: null });
    expect(String(row?.last_error)).not.toContain(FONNTE_TOKEN);
    expect(calls).toHaveLength(5);
    // FAILED rows are never claimed again.
    expect(await flushOutbox(env, [id], undefined, now + 86_400_000)).toEqual({ sent: 0, failed: 0, skipped: 0 });
  });

  it('provider echoing the token: nothing in outbox, API, audit or settings contains it', async () => {
    await configureFonnte();
    const admin = await person({ role: 'Admin' });
    // Fake provider that echoes back the Authorization header it received.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const auth = (init?.headers as Record<string, string>).Authorization;
      return new Response(JSON.stringify({ status: false, reason: `token ${auth} rejected` }), { status: 200 });
    });
    const target = uniquePhone();
    const id = await insertOutbox(target);
    await flushOutbox(env, [id]);
    const [row] = await outboxFor(target);
    expect(String(row?.last_error)).not.toContain(FONNTE_TOKEN);

    const test = await call('/api/admin/settings/whatsapp/test', { method: 'POST', cookie: admin.cookie });
    const text = await test.text();
    expect(text).not.toContain(FONNTE_TOKEN);
    expect(JSON.parse(text)).toEqual({ ok: false, provider: 'fonnte', detail: 'HTTP 200: Fonnte: token tidak valid.' });
    const audit = await env.DB.prepare(`SELECT description FROM log_aktivitas WHERE action = 'WA_TEST' AND actor_id = ?1`)
      .bind(admin.user.id)
      .first<{ description: string }>();
    expect(audit?.description).not.toContain(FONNTE_TOKEN);
    const settings = await (await call('/api/admin/settings/whatsapp', { cookie: admin.cookie })).text();
    expect(settings).not.toContain(FONNTE_TOKEN);
    const leaked = await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM notifikasi_outbox WHERE last_error LIKE ?1)
            + (SELECT COUNT(*) FROM log_aktivitas WHERE description LIKE ?1) AS n`,
    )
      .bind(`%${FONNTE_TOKEN}%`)
      .first<{ n: number }>();
    expect(leaked?.n).toBe(0);
  });

  it('outbox guard: no row when the post-condition does not hold', async () => {
    const target = uniquePhone();
    await env.DB.batch(
      outboxStatements(
        env.DB,
        [{ target, template: 'dokumen_baru_admin', params: { namaPegawai: 'A', namaDokumen: 'B' } }],
        uploadGuard(1, 'DOC-KTP', 'dokumen/none/never.pdf'),
        new Date().toISOString(),
      ),
    );
    expect(await outboxFor(target)).toHaveLength(0);
  });
});

describe('upload → dokumen_baru_admin', () => {
  it('queues one row per active admin with a phone, excluding the uploader and inactive admins', async () => {
    const a1 = await person({ role: 'Admin' });
    const a2 = await person({ role: 'Admin' });
    const inactive = await person({ role: 'Admin', statusAkun: 'Nonaktif' });
    const noPhone = await person({ role: 'Admin', phone: null });
    const uploader = await person({ role: 'Admin' });
    const res = await putDoc(uploader.cookie, 'DOC-KTP');
    expect(res.status).toBe(201);
    for (const a of [a1, a2]) {
      const rows = await outboxFor(a.phone!);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.template).toBe('dokumen_baru_admin');
      expect(JSON.parse(rows[0]!.params as string)).toMatchObject({ namaPegawai: `Pegawai Uji ${uploader.user.id}` });
    }
    expect(await outboxFor(inactive.phone!)).toHaveLength(0);
    expect(await outboxFor(uploader.phone!)).toHaveLength(0);
    expect(noPhone.phone).toBeNull();

    // The deferred flush sends exactly these rows (fetch mocked).
    await configureFonnte();
    const calls = mockFetch(() => fonnteOk());
    await runDeferredTasks();
    // Earlier tests in this file created more admins; one flush sends at most FLUSH_LIMIT.
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.length).toBeLessThanOrEqual(FLUSH_LIMIT);
    const sent = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM notifikasi_outbox WHERE status = 'SENT' AND template = 'dokumen_baru_admin'
          AND params LIKE ?1`,
    )
      .bind(`%Pegawai Uji ${uploader.user.id}"%`)
      .first<{ n: number }>();
    expect(sent?.n).toBe(calls.length);
  });

  it('re-upload also notifies; nothing when notif.dokumen_baru is off', async () => {
    const admin = await person({ role: 'Admin' });
    const owner = await person();
    expect((await putDoc(owner.cookie, 'DOC-KTP')).status).toBe(201);
    await env.DB.prepare(`UPDATE arsip_dokumen SET status = 'Ditolak' WHERE pegawai_id = ?1`).bind(owner.user.id).run();
    expect((await putDoc(owner.cookie, 'DOC-KTP')).status).toBe(200);
    expect(await outboxFor(admin.phone!)).toHaveLength(2);

    await setNotif({ dokumenBaru: false });
    const owner2 = await person();
    expect((await putDoc(owner2.cookie, 'DOC-KTP')).status).toBe(201);
    expect(await outboxFor(admin.phone!)).toHaveLength(2);
  });

  it('a rejected upload (pending already) queues nothing', async () => {
    const admin = await person({ role: 'Admin' });
    const owner = await person();
    expect((await putDoc(owner.cookie, 'DOC-KTP')).status).toBe(201);
    expect((await putDoc(owner.cookie, 'DOC-KTP')).status).toBe(409);
    expect(await outboxFor(admin.phone!)).toHaveLength(1);
  });
});

describe('settings', () => {
  it('notifications: GET/PUT with audit; strict body', async () => {
    const admin = await person({ role: 'Admin' });
    const get = await json<NotifSettings>(await call('/api/admin/settings/notifications', { cookie: admin.cookie }));
    expect(get).toEqual({ dokumenBaru: true, dokumenApproved: true, dokumenRejected: true });
    const put = await call('/api/admin/settings/notifications', {
      method: 'PUT',
      cookie: admin.cookie,
      body: { dokumenBaru: false, dokumenApproved: true, dokumenRejected: true },
    });
    expect(put.status).toBe(200);
    const raw = await env.DB.prepare(`SELECT value FROM pengaturan WHERE key = 'notif.dokumen_baru'`).first<{ value: string }>();
    expect(raw?.value).toBe('false');
    const audit = await env.DB.prepare(
      `SELECT description FROM log_aktivitas WHERE action = 'CONFIG_UPDATE' AND actor_id = ?1 ORDER BY id DESC`,
    )
      .bind(admin.user.id)
      .first<{ description: string }>();
    expect(audit?.description).toContain('notif.dokumen_baru');
    const bad = await call('/api/admin/settings/notifications', {
      method: 'PUT',
      cookie: admin.cookie,
      body: { dokumenBaru: false, dokumenApproved: true, dokumenRejected: true, extra: 1 },
    });
    expect(bad.status).toBe(400);
  });

  it('whatsapp: tokens encrypted, hint only, audit without values', async () => {
    const admin = await person({ role: 'Admin' });
    const res = await call('/api/admin/settings/whatsapp', {
      method: 'PUT',
      cookie: admin.cookie,
      body: { provider: 'fonnte', fonnteToken: FONNTE_TOKEN },
    });
    expect(res.status).toBe(200);
    const raw = await env.DB.prepare(`SELECT value, is_secret FROM pengaturan WHERE key = 'wa.fonnte.token'`).first<{
      value: string;
      is_secret: number;
    }>();
    expect(raw?.value.startsWith('v1:')).toBe(true);
    expect(raw?.value).not.toContain(FONNTE_TOKEN);
    expect(raw?.is_secret).toBe(1);

    const get = await call('/api/admin/settings/whatsapp', { cookie: admin.cookie });
    const text = await get.text();
    expect(text).not.toContain(FONNTE_TOKEN);
    const body = JSON.parse(text) as WhatsAppSettings;
    expect(body.provider).toBe('fonnte');
    expect(body.fonnte).toEqual({ configured: true, tokenHint: '••••ABCD' });
    expect(body.outbox).toMatchObject({ pending: expect.any(Number), failed: expect.any(Number) });

    const audit = await env.DB.prepare(
      `SELECT description FROM log_aktivitas WHERE action = 'CONFIG_UPDATE' AND actor_id = ?1 ORDER BY id DESC`,
    )
      .bind(admin.user.id)
      .first<{ description: string }>();
    expect(audit?.description).toContain('fonnteToken');
    expect(audit?.description).not.toContain(FONNTE_TOKEN);
  });

  it("whatsapp: omitted keeps, '' clears (also the selected provider), malformed rejected", async () => {
    const admin = await person({ role: 'Admin' });
    const put = (body: unknown) => call('/api/admin/settings/whatsapp', { method: 'PUT', cookie: admin.cookie, body });
    expect((await put({ provider: 'fonnte', fonnteToken: FONNTE_TOKEN })).status).toBe(200);

    // Selecting meta with an incomplete config is allowed; it is just not configured.
    await put({ provider: 'meta', metaPhoneNumberId: '' });
    const partial = await put({ provider: 'meta', metaToken: 'meta-token-1234' });
    expect(partial.status).toBe(200);
    expect((await json<WhatsAppSettings>(partial)).meta).toEqual({ configured: false, tokenHint: '••••1234', phoneNumberId: null });

    const ok = await put({ provider: 'meta', metaToken: 'meta-token-1234', metaPhoneNumberId: '1234567890' });
    expect(ok.status).toBe(200);
    const s = await json<WhatsAppSettings>(ok);
    expect(s.meta).toEqual({ configured: true, tokenHint: '••••1234', phoneNumberId: '1234567890' });
    expect(s.fonnte.configured).toBe(true); // omitted → kept

    const cleared = await json<WhatsAppSettings>(await put({ provider: 'meta', fonnteToken: '' }));
    expect(cleared.fonnte).toEqual({ configured: false, tokenHint: null });

    // Clearing the ACTIVE provider's token is allowed → unconfigured (contract: '' clears).
    const activeCleared = await put({ provider: 'meta', metaToken: '' });
    expect(activeCleared.status).toBe(200);
    const ac = await json<WhatsAppSettings>(activeCleared);
    expect(ac.provider).toBe('meta');
    expect(ac.meta).toEqual({ configured: false, tokenHint: null, phoneNumberId: '1234567890' });
    const get = await json<WhatsAppSettings>(await call('/api/admin/settings/whatsapp', { cookie: admin.cookie }));
    expect(get.meta.configured).toBe(false);
    // …and the test-send route reports it as not configured.
    const test = await call('/api/admin/settings/whatsapp/test', { method: 'POST', cookie: admin.cookie });
    expect(test.status).toBe(400);
    expect((await json<{ error: { fields: Record<string, string> } }>(test)).error.fields._form).toBe(
      'Konfigurasi WhatsApp belum lengkap.',
    );

    expect((await put({ provider: 'meta', metaPhoneNumberId: 'abc' })).status).toBe(400);
    expect((await put({ provider: 'meta', metaPhoneNumberId: '12a45' })).status).toBe(400);
    expect((await put({ provider: 'other' })).status).toBe(400);
  });

  it('whatsapp: a token that cannot be decrypted reads as unconfigured, never leaks', async () => {
    const admin = await person({ role: 'Admin' });
    await call('/api/admin/settings/whatsapp', {
      method: 'PUT',
      cookie: admin.cookie,
      body: { provider: 'fonnte', fonnteToken: FONNTE_TOKEN },
    });
    // Ciphertext under another key (e.g. a rotated SETTINGS_ENC_KEY).
    const otherKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
    await env.DB.prepare(`UPDATE pengaturan SET value = ?1 WHERE key = 'wa.fonnte.token'`)
      .bind(await encryptSetting(FONNTE_TOKEN, otherKey))
      .run();
    const res = await call('/api/admin/settings/whatsapp', { cookie: admin.cookie });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(FONNTE_TOKEN);
    expect((JSON.parse(text) as WhatsAppSettings).fonnte).toEqual({ configured: false, tokenHint: null });

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const test = await call('/api/admin/settings/whatsapp/test', { method: 'POST', cookie: admin.cookie });
    expect(test.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
    await configureFonnte(); // restore a valid config for later tests
  });

  it('whatsapp test: synchronous send to the admin, audited', async () => {
    await configureFonnte();
    const admin = await person({ role: 'Admin' });
    const calls = mockFetch(() => fonnteOk());
    const res = await call('/api/admin/settings/whatsapp/test', { method: 'POST', cookie: admin.cookie });
    expect(res.status).toBe(200);
    expect(await json<TestWhatsAppResponse>(res)).toEqual({ ok: true, provider: 'fonnte', detail: null });
    expect(new URLSearchParams(calls[0]!.init!.body as string).get('target')).toBe(admin.phone);
    const audit = await env.DB.prepare(`SELECT result FROM log_aktivitas WHERE action = 'WA_TEST' AND actor_id = ?1`)
      .bind(admin.user.id)
      .first<{ result: string }>();
    expect(audit?.result).toBe('SUCCESS');

    vi.restoreAllMocks();
    mockFetch(() => new Response('{"status":false,"reason":"device disconnected"}', { status: 200 }));
    const fail = await json<TestWhatsAppResponse>(
      await call('/api/admin/settings/whatsapp/test', { method: 'POST', cookie: admin.cookie }),
    );
    expect(fail).toEqual({ ok: false, provider: 'fonnte', detail: 'HTTP 200: Fonnte: perangkat tidak terhubung.' });
  });

  it('whatsapp test: 5 per admin per 10 minutes; the 6th is 429 without a provider call', async () => {
    await configureFonnte();
    const admin = await person({ role: 'Admin' });
    const other = await person({ role: 'Admin' });
    const calls = mockFetch(() => fonnteOk());
    const send = (cookie: string) => call('/api/admin/settings/whatsapp/test', { method: 'POST', cookie });
    for (let i = 0; i < 5; i++) expect((await send(admin.cookie)).status).toBe(200);
    expect(calls).toHaveLength(5);

    const limited = await send(admin.cookie);
    expect(limited.status).toBe(429);
    const body = await json<{ error: { code: string; retryAfterSeconds: number } }>(limited);
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.error.retryAfterSeconds).toBeGreaterThan(0);
    expect(body.error.retryAfterSeconds).toBeLessThanOrEqual(600);
    expect(limited.headers.get('Retry-After')).toBe(String(body.error.retryAfterSeconds));
    expect(calls).toHaveLength(5); // no provider call

    // Per admin: another admin is unaffected.
    expect((await send(other.cookie)).status).toBe(200);
    expect(calls).toHaveLength(6);
  });

  it('whatsapp test without phone → 400', async () => {
    const admin = await person({ role: 'Admin', phone: null });
    const res = await call('/api/admin/settings/whatsapp/test', { method: 'POST', cookie: admin.cookie });
    expect(res.status).toBe(400);
    expect((await json<{ error: { fields: Record<string, string> } }>(res)).error.fields._form).toBe(
      'Nomor HP Anda belum diisi di profil.',
    );
  });

  it('admin only + CSRF', async () => {
    const p = await person();
    expect((await call('/api/admin/settings/whatsapp', { cookie: p.cookie })).status).toBe(403);
    expect((await call('/api/admin/settings/notifications', { cookie: p.cookie })).status).toBe(403);
    const admin = await person({ role: 'Admin' });
    const csrf = await call('/api/admin/settings/whatsapp', {
      method: 'PUT',
      cookie: admin.cookie,
      body: { provider: 'fonnte', fonnteToken: 'x-evil' },
      origin: 'https://evil.example',
    });
    expect(csrf.status).toBe(403);
  });
});
