// Integration API (docs/RENCANA-API-INTEGRASI.md, contract: shared/integrasi.ts):
//   - authenticate `Authorization: Bearer skp_…` keys for /api/v1 (per-key rate limit,
//     per-IP failure counter, last-use stamp);
//   - read-only employee projections for /api/v1/pegawai;
//   - Admin management of keys (list / create, shown once / delete).
// Audit descriptions name the client and the public key id only, never the key itself.

import {
  API_AUTH_FAIL_LIMIT,
  API_RATE_LIMIT,
  IZIN_API,
  createKunciApiSchema,
  v1PegawaiQuerySchema,
  type IzinApi,
  type KunciApiCreateResponse,
  type KunciApiItem,
  type KunciApiListResponse,
  type V1PegawaiDetail,
  type V1PegawaiItem,
  type V1PegawaiListResponse,
  type V1PingResponse,
} from '../../shared/integrasi';
import { nipSchema } from '../../shared/validators';
import {
  deleteKunci,
  insertKunci,
  selectAllKunci,
  selectKunciById,
  selectKunciByPublicId,
  selectV1PegawaiByNip,
  touchKunci,
  v1PegawaiListStatements,
  type KunciApiRow,
  type V1PegawaiRow,
} from '../db/integrasi';
import { hitRateLimit, type RateLimitRow } from '../db/rate-limit';
import type { ApiClient, AuthContext, Bindings } from '../env';
import { auditStatement, type AuditActor } from '../lib/audit';
import { apiKeyPublicId, generateApiKey, hashApiKey, hexDigestEqual } from '../lib/crypto';
import { errors } from '../lib/errors';
import { addMinutes, secondsUntil, toIso } from '../lib/time';
import { parseWith } from '../lib/validation';
import type { RequestMeta } from './auth';

/** last_used_* is written at most this often per key. */
const TOUCH_INTERVAL_MINUTES = 5;
const DAY_MS = 86_400_000;
const KUNCI_ID = /^[1-9]\d{0,15}$/;

const MSG = {
  pegawaiNotFound: 'Pegawai tidak ditemukan.',
  kunciNotFound: 'Kunci API tidak ditemukan.',
} as const;

function adminActor(auth: AuthContext): AuditActor {
  const u = auth.user;
  return { id: u.id, nip: u.nip, nama: u.nama, role: u.role };
}

/** Integration clients appear in the activity log by their name, with role "API". */
function clientActor(client: Pick<ApiClient, 'nama'>): AuditActor {
  return { id: null, nip: null, nama: client.nama, role: 'API' };
}

/** Unknown or malformed stored scopes are dropped (fail closed). */
function parseIzin(raw: string): IzinApi[] {
  try {
    const list: unknown = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return IZIN_API.filter((i) => list.includes(i));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Authentication (/api/v1)
// ---------------------------------------------------------------------------

/** Key from `Authorization: Bearer <key>`; anything else (including a query parameter) is ignored. */
export function bearerToken(header: string | undefined): string | null {
  const m = header ? /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header) : null;
  return m?.[1] ?? null;
}

/**
 * Count a failed authentication per client IP and answer 401 (or 429 past the limit).
 * Only the first failure and the first overflow of a window are logged, so a misconfigured
 * or hostile client cannot flood log_aktivitas.
 */
async function rejectKey(env: Bindings, meta: RequestMeta, reason: string, idPublik: string | null): Promise<never> {
  const db = env.DB;
  const nowIso = toIso(meta.nowMs);
  const rl = await hitRateLimit(
    db,
    `api-auth-ip:${meta.ip ?? 'unknown'}`,
    nowIso,
    toIso(addMinutes(meta.nowMs, -API_AUTH_FAIL_LIMIT.windowMinutes)),
  ).first<RateLimitRow>();
  const count = rl?.count ?? 1;
  const keyLabel = idPublik ? ` (skp_${idPublik})` : '';
  if (count === 1) {
    await auditStatement(db, {
      ts: nowIso,
      actor: null,
      action: 'API_AUTH_FAILED',
      targetType: 'kunci_api',
      description: `Kunci API ditolak: ${reason}${keyLabel}. Kegagalan berikutnya dari IP ini dalam ${API_AUTH_FAIL_LIMIT.windowMinutes} menit tidak dicatat.`,
      result: 'FAILURE',
      ip: meta.ip,
    }).run();
  }
  if (rl && count > API_AUTH_FAIL_LIMIT.attempts) {
    if (count === API_AUTH_FAIL_LIMIT.attempts + 1) {
      await auditStatement(db, {
        ts: nowIso,
        actor: null,
        action: 'API_RATE_LIMITED',
        targetType: 'kunci_api',
        description: `Terlalu banyak kunci API ditolak dari IP ini (lebih dari ${API_AUTH_FAIL_LIMIT.attempts} dalam ${API_AUTH_FAIL_LIMIT.windowMinutes} menit).`,
        result: 'WARNING',
        ip: meta.ip,
      }).run();
    }
    const resetIso = toIso(addMinutes(Date.parse(rl.window_start), API_AUTH_FAIL_LIMIT.windowMinutes));
    throw errors.rateLimited(secondsUntil(resetIso, meta.nowMs));
  }
  throw errors.apiKeyInvalid();
}

/**
 * Resolve the bearer key into an `ApiClient`. Missing, malformed, unknown, deleted and expired
 * keys all get the same 401 API_KEY_INVALID; the reason only goes to the activity log.
 * Deleting a key takes effect on the next request (no cache).
 */
export async function authenticateApiKey(env: Bindings, authorization: string | undefined, meta: RequestMeta): Promise<ApiClient> {
  const token = bearerToken(authorization);
  if (!token) return rejectKey(env, meta, 'header Authorization tidak ada', null);
  const idPublik = apiKeyPublicId(token);
  if (!idPublik) return rejectKey(env, meta, 'format kunci salah', null);

  const db = env.DB;
  const [row, hash] = await Promise.all([selectKunciByPublicId(db, idPublik), hashApiKey(token)]);
  if (!row || !hexDigestEqual(row.token_hash, hash)) return rejectKey(env, meta, 'kunci tidak dikenal', idPublik);

  const nowIso = toIso(meta.nowMs);
  if (row.expires_at <= nowIso) return rejectKey(env, meta, 'kunci kedaluwarsa', idPublik);

  const client: ApiClient = { id: row.id, idPublik: row.id_publik, nama: row.nama, izin: parseIzin(row.izin), expiresAt: row.expires_at };
  const windowFloor = toIso(meta.nowMs - API_RATE_LIMIT.windowSeconds * 1000);
  const touchFloor = toIso(addMinutes(meta.nowMs, -TOUCH_INTERVAL_MINUTES));
  const [rlRes] = await db.batch([
    hitRateLimit(db, `api:${row.id}`, nowIso, windowFloor),
    touchKunci(db, row.id, nowIso, meta.ip, touchFloor),
  ]);
  const rl = rlRes?.results?.[0] as RateLimitRow | undefined;
  if (rl && rl.count > API_RATE_LIMIT.requests) {
    if (rl.count === API_RATE_LIMIT.requests + 1) {
      await auditStatement(db, {
        ts: nowIso,
        actor: clientActor(client),
        action: 'API_RATE_LIMITED',
        targetType: 'kunci_api',
        targetId: row.id,
        description: `Kunci API "${row.nama}" (skp_${row.id_publik}) melewati ${API_RATE_LIMIT.requests} permintaan per menit.`,
        result: 'WARNING',
        ip: meta.ip,
      }).run();
    }
    const resetIso = toIso(Date.parse(rl.window_start) + API_RATE_LIMIT.windowSeconds * 1000);
    throw errors.rateLimited(secondsUntil(resetIso, meta.nowMs));
  }
  return client;
}

// ---------------------------------------------------------------------------
// /api/v1 handlers
// ---------------------------------------------------------------------------

export function ping(client: ApiClient): V1PingResponse {
  return { klien: client.nama, idKunci: `skp_${client.idPublik}`, izin: client.izin, kedaluwarsa: client.expiresAt };
}

/** Explicit construction: the only fields a search result may carry (decision #1). */
function rowToV1Item(r: V1PegawaiRow): V1PegawaiItem {
  return {
    nip: r.nip,
    nama: r.nama,
    statusKepegawaian: r.status_kepegawaian,
    pangkat: r.pangkat_kode ? { kode: r.pangkat_kode, nama: r.pangkat_nama ?? r.pangkat_kode } : null,
    jabatan: r.jabatan,
    jenisJabatan: r.jenis_jabatan,
    unit: r.unit_id !== null && r.unit_nama !== null ? { id: r.unit_id, nama: r.unit_nama } : null,
    diperbarui: r.updated_at,
  };
}

export async function listV1Pegawai(env: Bindings, query: Record<string, string>): Promise<V1PegawaiListResponse> {
  const q = parseWith(v1PegawaiQuerySchema, query);
  const [pageStmt, totalStmt] = v1PegawaiListStatements(env.DB, {
    q: q.q,
    statusKepegawaian: q.statusKepegawaian,
    unitId: q.unitId,
    limit: q.pageSize,
    offset: (q.page - 1) * q.pageSize,
  });
  const [pageRes, totalRes] = await env.DB.batch([pageStmt, totalStmt]);
  const rows = (pageRes?.results ?? []) as V1PegawaiRow[];
  const total = (totalRes?.results?.[0] as { total: number } | undefined)?.total ?? 0;
  return { items: rows.map(rowToV1Item), page: q.page, pageSize: q.pageSize, total };
}

/** One active employee by NIP, with email and no HP; every read is logged (decision #7). */
export async function getV1Pegawai(env: Bindings, client: ApiClient, nipParam: string, meta: RequestMeta): Promise<V1PegawaiDetail> {
  const nip = parseWith(nipSchema, nipParam);
  const db = env.DB;
  const row = await selectV1PegawaiByNip(db, nip);
  if (!row) throw errors.notFound(MSG.pegawaiNotFound);
  await auditStatement(db, {
    ts: toIso(meta.nowMs),
    actor: clientActor(client),
    action: 'API_PEGAWAI_READ',
    targetType: 'pegawai',
    targetId: row.id,
    description: `Data pegawai NIP ${row.nip} dibaca lewat API oleh "${client.nama}" (skp_${client.idPublik}).`,
    result: 'SUCCESS',
    ip: meta.ip,
  }).run();
  return { ...rowToV1Item(row), email: row.email, noHp: row.no_hp };
}

// ---------------------------------------------------------------------------
// Admin: /api/admin/kunci-api
// ---------------------------------------------------------------------------

function rowToKunciItem(r: KunciApiRow): KunciApiItem {
  return {
    id: r.id,
    idPublik: r.id_publik,
    nama: r.nama,
    keterangan: r.keterangan,
    izin: parseIzin(r.izin),
    createdAt: r.created_at,
    createdBy: { id: r.created_by, nama: r.created_by_nama },
    expiresAt: r.expires_at,
    lastUsedAt: r.last_used_at,
    lastUsedIp: r.last_used_ip,
  };
}

export async function listKunci(env: Bindings): Promise<KunciApiListResponse> {
  return { items: (await selectAllKunci(env.DB)).map(rowToKunciItem) };
}

function isUniqueError(err: unknown): boolean {
  return /UNIQUE constraint failed/i.test(err instanceof Error ? err.message : String(err));
}

/** The plain key is returned here once and never stored or logged. */
export async function createKunci(env: Bindings, auth: AuthContext, body: unknown, meta: RequestMeta): Promise<KunciApiCreateResponse> {
  const input = parseWith(createKunciApiSchema, body);
  const db = env.DB;
  const createdAt = toIso(meta.nowMs);
  const expiresAt = toIso(meta.nowMs + input.masaBerlakuHari * DAY_MS);
  // 48-bit public ids: a collision is practically impossible; retry once just in case.
  for (let attempt = 0; ; attempt++) {
    const { kunci, idPublik } = generateApiKey();
    try {
      const [insRes] = await db.batch([
        insertKunci(db, {
          idPublik,
          tokenHash: await hashApiKey(kunci),
          nama: input.nama,
          keterangan: input.keterangan,
          izin: input.izin,
          createdAt,
          createdBy: auth.user.id,
          createdByNama: auth.user.nama,
          expiresAt,
        }),
        auditStatement(
          db,
          {
            ts: createdAt,
            actor: adminActor(auth),
            action: 'APIKEY_CREATE',
            targetType: 'kunci_api',
            description: `Kunci API "${input.nama}" (skp_${idPublik}) dibuat; izin: ${input.izin.join(', ')}; berlaku ${input.masaBerlakuHari} hari.`,
            result: 'SUCCESS',
            ip: meta.ip,
          },
          { targetIdFromLastInsert: true },
        ),
      ]);
      const row = insRes?.results?.[0] as KunciApiRow | undefined;
      if (!row) throw new Error('kunci_api insert returned no row');
      return { item: rowToKunciItem(row), kunci };
    } catch (err) {
      if (attempt === 0 && isUniqueError(err)) continue;
      throw err;
    }
  }
}

/** Deleting revokes immediately; the audit row keeps the client name and public id. */
export async function deleteKunciApi(env: Bindings, auth: AuthContext, idParam: string, meta: RequestMeta): Promise<void> {
  if (!KUNCI_ID.test(idParam)) throw errors.notFound(MSG.kunciNotFound);
  const id = Number(idParam);
  const db = env.DB;
  const row = await selectKunciById(db, id);
  if (!row) throw errors.notFound(MSG.kunciNotFound);
  const [delRes] = await db.batch([
    deleteKunci(db, id),
    auditStatement(
      db,
      {
        ts: toIso(meta.nowMs),
        actor: adminActor(auth),
        action: 'APIKEY_DELETE',
        targetType: 'kunci_api',
        targetId: id,
        description: `Kunci API "${row.nama}" (skp_${row.id_publik}) dihapus.`,
        result: 'SUCCESS',
        ip: meta.ip,
      },
      { onlyIfPreviousChanged: true },
    ),
  ]);
  if ((delRes?.meta.changes ?? 0) === 0) throw errors.notFound(MSG.kunciNotFound);
}
