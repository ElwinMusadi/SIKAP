// Phase 5: notification toggles + WhatsApp provider settings (contract: shared/verifikasi.ts).
// Tokens are stored AES-GCM encrypted (lib/secrets.ts) and are never returned or audited.
import {
  notifSettingsSchema,
  updateWhatsAppSchema,
  type NotifSettings,
  type TestWhatsAppResponse,
  type WaProvider,
  type WhatsAppSettings,
} from '../../shared/verifikasi';
import { normalizePhone } from '../../shared/validators';
import {
  deleteSetting,
  NOTIF_KEYS,
  notifEnabled,
  selectOutboxStats,
  selectSettings,
  SETTING_KEYS,
  settingsMap,
  upsertSetting,
  WA_KEYS,
  type OutboxStatsRow,
  type SettingRow,
} from '../db/pengaturan';
import type { AuthContext, Bindings } from '../env';
import { auditStatement } from '../lib/audit';
import { errors } from '../lib/errors';
import { decryptSetting, encryptSetting } from '../lib/secrets';
import { hitRateLimit, type RateLimitRow } from '../db/rate-limit';
import { addMinutes, secondsUntil, toIso } from '../lib/time';
import { parseWith } from '../lib/validation';
import { sendWhatsApp, type WaConfig } from '../lib/whatsapp';
import type { RequestMeta } from './auth';

const DAY_MS = 86_400_000;

/** Generic message for a missing/undecryptable provider config (also used as outbox last_error). */
export const WA_NOT_CONFIGURED = 'Konfigurasi WhatsApp belum lengkap.';

/** Bindings needed to resolve the provider config (narrow, so the cron worker can use it). */
export type WaEnv = Pick<Bindings, 'DB' | 'APP_URL' | 'SETTINGS_ENC_KEY'>;

const MSG = {
  noPhone: 'Nomor HP Anda belum diisi di profil.',
  notConfigured: WA_NOT_CONFIGURED,
} as const;

function actor(auth: AuthContext) {
  const u = auth.user;
  return { id: u.id, nip: u.nip, nama: u.nama, role: u.role };
}

// ---------------------------------------------------------------------------
// Notification toggles
// ---------------------------------------------------------------------------

const NOTIF_FIELD: Record<keyof NotifSettings, (typeof NOTIF_KEYS)[number]> = {
  dokumenBaru: SETTING_KEYS.notifDokumenBaru,
  dokumenApproved: SETTING_KEYS.notifDokumenApproved,
  dokumenRejected: SETTING_KEYS.notifDokumenRejected,
};

function toNotif(map: Map<string, SettingRow>): NotifSettings {
  return {
    dokumenBaru: notifEnabled(map, SETTING_KEYS.notifDokumenBaru),
    dokumenApproved: notifEnabled(map, SETTING_KEYS.notifDokumenApproved),
    dokumenRejected: notifEnabled(map, SETTING_KEYS.notifDokumenRejected),
  };
}

export async function getNotifSettings(env: Bindings): Promise<NotifSettings> {
  const { results } = await selectSettings(env.DB, NOTIF_KEYS).all<SettingRow>();
  return toNotif(settingsMap(results));
}

export async function saveNotifSettings(
  env: Bindings,
  auth: AuthContext,
  body: unknown,
  meta: RequestMeta,
): Promise<NotifSettings> {
  const next = parseWith(notifSettingsSchema, body);
  const db = env.DB;
  const nowIso = toIso(meta.nowMs);
  const current = await getNotifSettings(env);
  const changed = (Object.keys(NOTIF_FIELD) as (keyof NotifSettings)[]).filter((k) => current[k] !== next[k]);
  await db.batch([
    ...(Object.keys(NOTIF_FIELD) as (keyof NotifSettings)[]).map((k) =>
      upsertSetting(db, NOTIF_FIELD[k], next[k] ? 'true' : 'false', false, nowIso, auth.user.id),
    ),
    auditStatement(db, {
      ts: nowIso,
      actor: actor(auth),
      action: 'CONFIG_UPDATE',
      targetType: 'pengaturan',
      targetId: 'notifikasi',
      description: changed.length
        ? `Ubah pengaturan notifikasi: ${changed.map((k) => `${NOTIF_FIELD[k]}=${next[k]}`).join(', ')}`
        : 'Simpan pengaturan notifikasi (tanpa perubahan)',
      result: 'SUCCESS',
      ip: meta.ip,
    }),
  ]);
  return next;
}

// ---------------------------------------------------------------------------
// WhatsApp provider
// ---------------------------------------------------------------------------

async function decryptOrNull(row: SettingRow | undefined, key: string): Promise<string | null> {
  if (!row || !row.value) return null;
  try {
    const plain = await decryptSetting(row.value, key);
    return plain ? plain : null;
  } catch {
    // Wrong/rotated/invalid key or tampered value: treat as not configured (never surface details).
    return null;
  }
}

function hint(token: string | null): string | null {
  return token ? `••••${token.slice(-4)}` : null;
}

function providerOf(map: Map<string, SettingRow>): WaProvider {
  return map.get(SETTING_KEYS.waProvider)?.value === 'meta' ? 'meta' : 'fonnte';
}

/**
 * Provider config with decrypted tokens, or null when the selected provider is incomplete
 * or its token cannot be decrypted. Never throws.
 */
export async function waConfigFromRows(env: WaEnv, rows: SettingRow[] | undefined): Promise<WaConfig | null> {
  const map = settingsMap(rows);
  const provider = providerOf(map);
  if (provider === 'fonnte') {
    const token = await decryptOrNull(map.get(SETTING_KEYS.waFonnteToken), env.SETTINGS_ENC_KEY);
    return token ? { provider, token, appUrl: env.APP_URL } : null;
  }
  const token = await decryptOrNull(map.get(SETTING_KEYS.waMetaToken), env.SETTINGS_ENC_KEY);
  const phoneId = map.get(SETTING_KEYS.waMetaPhoneId)?.value ?? '';
  return token && phoneId ? { provider, token, phoneId, appUrl: env.APP_URL } : null;
}

export function selectWaSettings(db: D1Database): D1PreparedStatement {
  return selectSettings(db, WA_KEYS);
}

export async function getWhatsAppSettings(env: Bindings, nowMs: number = Date.now()): Promise<WhatsAppSettings> {
  const [sRes, oRes] = await env.DB.batch([
    selectWaSettings(env.DB),
    selectOutboxStats(env.DB, toIso(nowMs - DAY_MS)),
  ]);
  const map = settingsMap(sRes?.results as SettingRow[] | undefined);
  const stats = (oRes?.results?.[0] as OutboxStatsRow | undefined) ?? { pending: 0, failed: 0, sent24: 0, last_error: null };
  const fonnteToken = await decryptOrNull(map.get(SETTING_KEYS.waFonnteToken), env.SETTINGS_ENC_KEY);
  const metaToken = await decryptOrNull(map.get(SETTING_KEYS.waMetaToken), env.SETTINGS_ENC_KEY);
  const phoneNumberId = map.get(SETTING_KEYS.waMetaPhoneId)?.value || null;
  return {
    provider: providerOf(map),
    fonnte: { configured: fonnteToken !== null, tokenHint: hint(fonnteToken) },
    meta: { configured: metaToken !== null && phoneNumberId !== null, tokenHint: hint(metaToken), phoneNumberId },
    outbox: {
      pending: stats.pending ?? 0,
      failed: stats.failed ?? 0,
      sentLast24h: stats.sent24 ?? 0,
      lastError: stats.last_error ?? null,
    },
  };
}

export async function updateWhatsAppSettings(
  env: Bindings,
  auth: AuthContext,
  body: unknown,
  meta: RequestMeta,
): Promise<WhatsAppSettings> {
  const input = parseWith(updateWhatsAppSchema, body);
  const db = env.DB;
  const nowIso = toIso(meta.nowMs);
  const map = settingsMap((await selectWaSettings(db).all<SettingRow>()).results);

  // Omitted = keep, '' = clear (shared/verifikasi.ts). Clearing the token of the selected
  // provider is allowed: the provider is then simply unconfigured (GET configured=false,
  // outbox rows wait without consuming attempts, test-send answers 400). Only malformed
  // values are rejected, by the schema.
  const stmts: D1PreparedStatement[] = [];
  const changed: string[] = [];
  if (providerOf(map) !== input.provider || !map.has(SETTING_KEYS.waProvider)) changed.push('provider');
  stmts.push(upsertSetting(db, SETTING_KEYS.waProvider, input.provider, false, nowIso, auth.user.id));

  const apply = async (field: string, value: string | undefined, key: string, secret: boolean) => {
    if (value === undefined) return;
    changed.push(field);
    if (value === '') stmts.push(deleteSetting(db, key));
    else {
      const stored = secret ? await encryptSetting(value, env.SETTINGS_ENC_KEY) : value;
      stmts.push(upsertSetting(db, key, stored, secret, nowIso, auth.user.id));
    }
  };
  await apply('fonnteToken', input.fonnteToken, SETTING_KEYS.waFonnteToken, true);
  await apply('metaToken', input.metaToken, SETTING_KEYS.waMetaToken, true);
  await apply('metaPhoneNumberId', input.metaPhoneNumberId, SETTING_KEYS.waMetaPhoneId, false);

  stmts.push(
    auditStatement(db, {
      ts: nowIso,
      actor: actor(auth),
      action: 'CONFIG_UPDATE',
      targetType: 'pengaturan',
      targetId: 'whatsapp',
      // Field names only, never values (tokens are secrets).
      description: `Ubah pengaturan WhatsApp (provider ${input.provider}): ${changed.join(', ') || 'tanpa perubahan'}`,
      result: 'SUCCESS',
      ip: meta.ip,
    }),
  );
  await db.batch(stmts);
  return getWhatsAppSettings(env, meta.nowMs);
}

/** Per-admin limit on test sends (each one is a real provider message). */
export const WA_TEST_LIMIT = { maxAttempts: 5, windowMinutes: 10 } as const;

/** POST /api/admin/settings/whatsapp/test: synchronous send to the requesting admin. */
export async function testWhatsApp(env: Bindings, auth: AuthContext, meta: RequestMeta): Promise<TestWhatsAppResponse> {
  const db = env.DB;
  // Round trip 1: count the hit atomically (UPSERT … RETURNING), then read profile + settings.
  // Every request counts, including ones rejected below, so the limit cannot be probed.
  const [rlRes, pRes, sRes] = await db.batch([
    hitRateLimit(
      db,
      `wa-test:${auth.user.id}`,
      toIso(meta.nowMs),
      toIso(addMinutes(meta.nowMs, -WA_TEST_LIMIT.windowMinutes)),
    ),
    db.prepare(`SELECT nama, no_hp FROM pegawai WHERE id = ?1 AND deleted_at IS NULL`).bind(auth.user.id),
    selectWaSettings(db),
  ]);
  const rl = rlRes?.results?.[0] as RateLimitRow | undefined;
  if (rl && rl.count > WA_TEST_LIMIT.maxAttempts) {
    const resetIso = toIso(addMinutes(Date.parse(rl.window_start), WA_TEST_LIMIT.windowMinutes));
    throw errors.rateLimited(secondsUntil(resetIso, meta.nowMs));
  }
  const me = (pRes?.results?.[0] as { nama: string; no_hp: string | null } | undefined) ?? null;
  const to = me?.no_hp ? normalizePhone(me.no_hp) : null;
  if (!me || !to) throw errors.validation({ _form: MSG.noPhone });
  const rows = sRes?.results as SettingRow[] | undefined;
  const provider = providerOf(settingsMap(rows));
  const cfg = await waConfigFromRows(env, rows);
  if (!cfg) throw errors.validation({ _form: MSG.notConfigured });

  const res = await sendWhatsApp(cfg, to, 'test', { nama: me.nama });
  await auditStatement(db, {
    ts: toIso(meta.nowMs),
    actor: actor(auth),
    action: 'WA_TEST',
    targetType: 'pengaturan',
    targetId: 'whatsapp',
    // res.detail is generic (lib/whatsapp.ts never returns provider text).
    description: res.ok ? `Uji kirim WhatsApp (${provider}) berhasil` : `Uji kirim WhatsApp (${provider}) gagal: ${res.detail ?? ''}`,
    result: res.ok ? 'SUCCESS' : 'FAILURE',
    ip: meta.ip,
  }).run();
  return { ok: res.ok, provider, detail: res.ok ? null : (res.detail ?? null) };
}
