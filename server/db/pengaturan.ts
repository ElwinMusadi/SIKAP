// SQL helpers for `pengaturan` (key/value settings) and outbox health (Phase 5).
// Mutation helpers return prepared statements so the service can batch them with
// the audit row (MIGRATION_PLAN §3.1 rule 10).

export const SETTING_KEYS = {
  notifDokumenBaru: 'notif.dokumen_baru',
  notifDokumenApproved: 'notif.dokumen_approved',
  notifDokumenRejected: 'notif.dokumen_rejected',
  waProvider: 'wa.provider',
  waFonnteToken: 'wa.fonnte.token',
  waMetaToken: 'wa.meta.token',
  waMetaPhoneId: 'wa.meta.phone_id',
} as const;

export const NOTIF_KEYS = [
  SETTING_KEYS.notifDokumenBaru,
  SETTING_KEYS.notifDokumenApproved,
  SETTING_KEYS.notifDokumenRejected,
] as const;
export type NotifKey = (typeof NOTIF_KEYS)[number];

export const WA_KEYS = [
  SETTING_KEYS.waProvider,
  SETTING_KEYS.waFonnteToken,
  SETTING_KEYS.waMetaToken,
  SETTING_KEYS.waMetaPhoneId,
] as const;

export interface SettingRow {
  key: string;
  value: string;
  is_secret: number;
}

/** Rows for the given keys (missing keys are simply absent). */
export function selectSettings(db: D1Database, keys: readonly string[]): D1PreparedStatement {
  return db
    .prepare(`SELECT key, value, is_secret FROM pengaturan WHERE key IN (SELECT value FROM json_each(?1))`)
    .bind(JSON.stringify(keys));
}

export function settingsMap(rows: SettingRow[] | undefined): Map<string, SettingRow> {
  return new Map((rows ?? []).map((r) => [r.key, r]));
}

/** A notification toggle is ON unless explicitly stored as 'false' (seed default 'true'). */
export function notifEnabled(map: Map<string, SettingRow>, key: NotifKey): boolean {
  return map.get(key)?.value !== 'false';
}

export function upsertSetting(
  db: D1Database,
  key: string,
  value: string,
  isSecret: boolean,
  nowIso: string,
  actorId: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO pengaturan (key, value, is_secret, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, is_secret = excluded.is_secret,
                                      updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    )
    .bind(key, value, isSecret ? 1 : 0, nowIso, actorId);
}

export function deleteSetting(db: D1Database, key: string): D1PreparedStatement {
  return db.prepare(`DELETE FROM pengaturan WHERE key = ?1`).bind(key);
}

export interface OutboxStatsRow {
  pending: number;
  failed: number;
  sent24: number;
  last_error: string | null;
}

/** Outbox health in one statement. */
export function selectOutboxStats(db: D1Database, sinceIso: string): D1PreparedStatement {
  return db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM notifikasi_outbox WHERE status = 'PENDING') AS pending,
         (SELECT COUNT(*) FROM notifikasi_outbox WHERE status = 'FAILED') AS failed,
         (SELECT COUNT(*) FROM notifikasi_outbox WHERE status = 'SENT' AND sent_at >= ?1) AS sent24,
         (SELECT last_error FROM notifikasi_outbox
           WHERE status IN ('FAILED', 'PENDING') AND last_error IS NOT NULL
           ORDER BY created_at DESC, id DESC LIMIT 1) AS last_error`,
    )
    .bind(sinceIso);
}
