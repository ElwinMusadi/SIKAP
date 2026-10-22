// Phase 7 administration: activity log viewer, reference data and document types.
// Contract: shared/administrasi.ts. Every mutation writes its audit row in the same
// D1 batch, gated on the mutation having changed a row (MIGRATION_PLAN §3.1 rule 10).

import {
  createJenisSchema,
  createPangkatSchema,
  createUnitSchema,
  logQuerySchema,
  updateJenisSchema,
  updatePangkatSchema,
  updateUnitSchema,
  type AdminJenisDokumen,
  type AdminJenisResponse,
  type AdminPangkat,
  type AdminRefResponse,
  type AdminUnit,
  type LogCategory,
  type LogItem,
  type LogResponse,
} from '../../shared/administrasi';
import { STATUS_KEPEGAWAIAN, type LogResult, type StatusKepegawaian } from '../../shared/enums';
import {
  deleteWajibIfStamp,
  insertJenis,
  insertPangkat,
  insertUnit,
  insertWajib,
  insertWajibIfStamp,
  pangkatConflicts,
  selectAllJenis,
  selectAllPangkat,
  selectAllPendidikan,
  selectAllUnit,
  selectJenis,
  selectLogPage,
  selectPangkat,
  selectUnit,
  unitNamaConflict,
  updateJenisIfStamp,
  updatePangkat,
  updateUnit,
  type JenisRow,
  type LogRow,
  type PangkatRow,
  type PendidikanRow,
  type UnitRow,
} from '../db/administrasi';
import type { AuthContext, Bindings } from '../env';
import { auditStatement, type AuditActor } from '../lib/audit';
import { ApiError, errors } from '../lib/errors';
import { toIso } from '../lib/time';
import { parseWith } from '../lib/validation';
import type { RequestMeta } from './auth';

export const LOG_PAGE_SIZE = 25;

const MSG = {
  pangkatNotFound: 'Pangkat/golongan tidak ditemukan.',
  unitNotFound: 'Unit organisasi tidak ditemukan.',
  jenisNotFound: 'Jenis dokumen tidak ditemukan.',
  kodeTaken: 'Kode pangkat/golongan sudah digunakan.',
  pangkatNamaTaken: 'Nama pangkat/golongan sudah digunakan.',
  unitNamaTaken: 'Nama unit organisasi sudah digunakan.',
  jenisIdTaken: 'ID jenis dokumen sudah digunakan.',
  stale: 'Data jenis dokumen telah diubah oleh admin lain. Muat ulang lalu coba lagi.',
  cursor: 'Cursor halaman tidak valid.',
} as const;

function actor(auth: AuthContext): AuditActor {
  const u = auth.user;
  return { id: u.id, nip: u.nip, nama: u.nama, role: u.role };
}

function first<T>(res: D1Result | undefined): T | null {
  return ((res?.results?.[0] as T | undefined) ?? null);
}

function isUniqueError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed/i.test(msg);
}

function conflictFields(fields: Record<string, string>): ApiError {
  const msgs = Object.values(fields);
  return new ApiError(409, 'CONFLICT', msgs.length === 1 ? msgs[0]! : 'Data sudah digunakan.', { fields });
}

/** Field names only — never values — for audit descriptions. */
function fieldList(body: Record<string, unknown>, exclude: readonly string[] = []): string {
  return Object.keys(body).filter((k) => !exclude.includes(k)).join(', ');
}

const boolInt = (v: boolean | undefined): number | null => (v === undefined ? null : v ? 1 : 0);

// ---------------------------------------------------------------------------
// Activity log
// ---------------------------------------------------------------------------

/** Whitelisted action prefixes per category. Never derived from caller input. */
export const LOG_CATEGORY_PREFIXES: Record<LogCategory, readonly string[]> = {
  auth: ['LOGIN', 'LOGOUT', 'PASSWORD', 'SESSION', 'ACCOUNT'],
  pegawai: ['PEGAWAI', 'PROFILE', 'FOTO'],
  dokumen: ['DOKUMEN'],
  pengajuan: ['PENGAJUAN'],
  sistem: ['CONFIG', 'WA', 'BACKUP', 'REF', 'JENIS'],
  // String prefix: covers APIKEY_* (key management) and API_* (integration requests).
  integrasi: ['API'],
};

/** `[prefix, successor)` so `action >= lo AND action < hi` ⇔ action starts with prefix (BINARY collation). */
function prefixRange(prefix: string): readonly [string, string] {
  const last = prefix.charCodeAt(prefix.length - 1);
  return [prefix, prefix.slice(0, -1) + String.fromCharCode(last + 1)];
}

export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CURSOR_ID = /^[1-9]\d{0,15}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;

function b64urlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function encodeLogCursor(ts: string, id: number): string {
  return b64urlEncode(`${ts}|${id}`);
}

/** Strict: canonical base64url of `<ISO ms UTC>|<positive int>`; anything else is 400. */
export function decodeLogCursor(raw: string): { ts: string; id: number } {
  const bad = () => errors.validation({ cursor: MSG.cursor });
  if (raw.length > 200 || !B64URL.test(raw) || raw.length % 4 === 1) throw bad();
  let text: string;
  try {
    const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
    text = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  } catch {
    throw bad();
  }
  const sep = text.indexOf('|');
  if (sep < 0) throw bad();
  const ts = text.slice(0, sep);
  const idText = text.slice(sep + 1);
  if (!ISO_MS.test(ts) || !CURSOR_ID.test(idText)) throw bad();
  const ms = Date.parse(ts);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== ts) throw bad();
  const id = Number(idText);
  if (!Number.isSafeInteger(id) || id < 1) throw bad();
  if (encodeLogCursor(ts, id) !== raw) throw bad();
  return { ts, id };
}

/** WITA (UTC+8) calendar day start as ISO UTC. */
function witaDayStartIso(day: string, addDays = 0): string {
  const ms = Date.parse(`${day}T00:00:00.000+08:00`) + addDays * 86_400_000;
  return toIso(ms);
}

function toLogItem(r: LogRow): LogItem {
  return {
    id: r.id,
    ts: r.ts,
    actor: { id: r.actor_id, nip: r.actor_nip, nama: r.actor_nama, role: r.actor_role },
    action: r.action,
    targetType: r.target_type,
    targetId: r.target_id,
    description: r.description,
    result: r.result as LogResult,
  };
}

export async function listLog(env: Bindings, query: Record<string, string>): Promise<LogResponse> {
  // Empty params (`?q=&category=`) mean "no filter".
  const cleaned = Object.fromEntries(Object.entries(query).filter(([, v]) => v !== ''));
  const q = parseWith(logQuerySchema, cleaned);
  const cursor = q.cursor ? decodeLogCursor(q.cursor) : null;
  const text = q.q ? q.q : null;
  const { results } = await selectLogPage(env.DB, {
    likePattern: text ? `%${escapeLike(text)}%` : null,
    actionRanges: q.category ? LOG_CATEGORY_PREFIXES[q.category].map(prefixRange) : [],
    result: q.result ?? null,
    fromIso: q.from ? witaDayStartIso(q.from) : null,
    toIso: q.to ? witaDayStartIso(q.to, 1) : null,
    cursor,
    limit: LOG_PAGE_SIZE + 1,
  }).all<LogRow>();
  const rows = results ?? [];
  const page = rows.slice(0, LOG_PAGE_SIZE);
  const last = page[page.length - 1];
  return {
    items: page.map(toLogItem),
    nextCursor: rows.length > LOG_PAGE_SIZE && last ? encodeLogCursor(last.ts, last.id) : null,
  };
}

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

function toPangkat(r: PangkatRow): AdminPangkat {
  return { kode: r.kode, nama: r.nama, jenisAsn: r.jenis_asn, urutan: r.urutan, aktif: r.aktif === 1 };
}
function toUnit(r: UnitRow): AdminUnit {
  return { id: r.id, nama: r.nama, aktif: r.aktif === 1 };
}

export async function getAdminRef(env: Bindings): Promise<AdminRefResponse> {
  const db = env.DB;
  const [p, u, d] = await db.batch([selectAllPangkat(db), selectAllUnit(db), selectAllPendidikan(db)]);
  return {
    pangkat: ((p?.results ?? []) as PangkatRow[]).map(toPangkat),
    unit: ((u?.results ?? []) as UnitRow[]).map(toUnit),
    pendidikan: ((d?.results ?? []) as PendidikanRow[]).map((r) => ({ kode: r.kode, nama: r.nama, urutan: r.urutan })),
  };
}

const PANGKAT_KODE_PARAM = /^[A-Za-z0-9/._-]{1,20}$/;
const UNIT_ID_PARAM = /^[1-9]\d{0,9}$/;

function pangkatConflictError(row: { kode: number; nama: number } | null): ApiError | null {
  if (!row) return null;
  const fields: Record<string, string> = {};
  if (row.kode) fields.kode = MSG.kodeTaken;
  if (row.nama) fields.nama = MSG.pangkatNamaTaken;
  return Object.keys(fields).length ? conflictFields(fields) : null;
}

export async function createPangkat(
  env: Bindings,
  auth: AuthContext,
  body: unknown,
  meta: RequestMeta,
): Promise<{ item: AdminPangkat }> {
  const v = parseWith(createPangkatSchema, body);
  const db = env.DB;
  const nowIso = toIso(meta.nowMs);
  let results: D1Result[];
  try {
    results = await db.batch([
      insertPangkat(db, { kode: v.kode, nama: v.nama, jenis_asn: v.jenisAsn, urutan: v.urutan, aktif: v.aktif ? 1 : 0 }),
      auditStatement(
        db,
        {
          ts: nowIso,
          actor: actor(auth),
          action: 'REF_CREATE',
          targetType: 'ref_pangkat_golongan',
          targetId: v.kode,
          description: `Tambah pangkat/golongan: ${fieldList(v)}`,
          result: 'SUCCESS',
          ip: meta.ip,
        },
        { onlyIfPreviousChanged: true },
      ),
      selectPangkat(db, v.kode),
      pangkatConflicts(db, v.kode, v.nama, null),
    ]);
  } catch (err) {
    if (isUniqueError(err)) throw errors.conflict(MSG.kodeTaken, 'kode');
    throw err;
  }
  if ((results[0]?.meta.changes ?? 0) !== 1) {
    throw pangkatConflictError(first(results[3])) ?? errors.conflict(MSG.kodeTaken, 'kode');
  }
  const row = first<PangkatRow>(results[2]);
  if (!row) throw new Error('pangkat insert not visible');
  return { item: toPangkat(row) };
}

export async function updatePangkatRef(
  env: Bindings,
  auth: AuthContext,
  kodeParam: string,
  body: unknown,
  meta: RequestMeta,
): Promise<{ item: AdminPangkat }> {
  if (!PANGKAT_KODE_PARAM.test(kodeParam)) throw errors.notFound(MSG.pangkatNotFound);
  const v = parseWith(updatePangkatSchema, body);
  const db = env.DB;
  const nowIso = toIso(meta.nowMs);
  const results = await db.batch([
    updatePangkat(db, kodeParam, { nama: v.nama ?? null, urutan: v.urutan ?? null, aktif: boolInt(v.aktif) }),
    auditStatement(
      db,
      {
        ts: nowIso,
        actor: actor(auth),
        action: 'REF_UPDATE',
        targetType: 'ref_pangkat_golongan',
        targetId: kodeParam,
        description: `Ubah pangkat/golongan: ${fieldList(v)}`,
        result: 'SUCCESS',
        ip: meta.ip,
      },
      { onlyIfPreviousChanged: true },
    ),
    selectPangkat(db, kodeParam),
    pangkatConflicts(db, null, v.nama ?? null, kodeParam),
  ]);
  const row = first<PangkatRow>(results[2]);
  if (!row) throw errors.notFound(MSG.pangkatNotFound);
  if ((results[0]?.meta.changes ?? 0) !== 1) {
    throw pangkatConflictError(first(results[3])) ?? errors.conflict(MSG.pangkatNamaTaken, 'nama');
  }
  return { item: toPangkat(row) };
}

export async function createUnitRef(
  env: Bindings,
  auth: AuthContext,
  body: unknown,
  meta: RequestMeta,
): Promise<{ item: AdminUnit }> {
  const v = parseWith(createUnitSchema, body);
  const db = env.DB;
  const nowIso = toIso(meta.nowMs);
  const results = await db.batch([
    insertUnit(db, v.nama, v.aktif ? 1 : 0),
    auditStatement(
      db,
      {
        ts: nowIso,
        actor: actor(auth),
        action: 'REF_CREATE',
        targetType: 'ref_unit_organisasi',
        description: `Tambah unit organisasi: ${fieldList(v)}`,
        result: 'SUCCESS',
        ip: meta.ip,
      },
      { onlyIfPreviousChanged: true, targetIdFromLastInsert: true },
    ),
  ]);
  const row = first<UnitRow>(results[0]);
  if (!row) throw errors.conflict(MSG.unitNamaTaken, 'nama');
  return { item: toUnit(row) };
}

export async function updateUnitRef(
  env: Bindings,
  auth: AuthContext,
  idParam: string,
  body: unknown,
  meta: RequestMeta,
): Promise<{ item: AdminUnit }> {
  if (!UNIT_ID_PARAM.test(idParam)) throw errors.notFound(MSG.unitNotFound);
  const id = Number(idParam);
  const v = parseWith(updateUnitSchema, body);
  const db = env.DB;
  const nowIso = toIso(meta.nowMs);
  const results = await db.batch([
    updateUnit(db, id, { nama: v.nama ?? null, aktif: boolInt(v.aktif) }),
    auditStatement(
      db,
      {
        ts: nowIso,
        actor: actor(auth),
        action: 'REF_UPDATE',
        targetType: 'ref_unit_organisasi',
        targetId: id,
        description: `Ubah unit organisasi: ${fieldList(v)}`,
        result: 'SUCCESS',
        ip: meta.ip,
      },
      { onlyIfPreviousChanged: true },
    ),
    selectUnit(db, id),
    unitNamaConflict(db, v.nama ?? '', id),
  ]);
  const row = first<UnitRow>(results[2]);
  if (!row) throw errors.notFound(MSG.unitNotFound);
  if ((results[0]?.meta.changes ?? 0) !== 1) throw errors.conflict(MSG.unitNamaTaken, 'nama');
  return { item: toUnit(row) };
}

// ---------------------------------------------------------------------------
// Jenis dokumen
// ---------------------------------------------------------------------------

const JENIS_ID_PARAM = /^DOC-[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
const STATUS_ORDER = new Map(STATUS_KEPEGAWAIAN.map((s, i) => [s, i]));

function parseWajib(json: string): StatusKepegawaian[] {
  let arr: unknown;
  try {
    arr = JSON.parse(json);
  } catch {
    arr = [];
  }
  return (Array.isArray(arr) ? arr : [])
    .filter((s): s is StatusKepegawaian => STATUS_ORDER.has(s as StatusKepegawaian))
    .sort((a, b) => STATUS_ORDER.get(a)! - STATUS_ORDER.get(b)!);
}

function toJenis(r: JenisRow): AdminJenisDokumen {
  return {
    id: r.id,
    nama: r.nama,
    kategori: r.kategori,
    urutan: r.urutan,
    aktif: r.aktif === 1,
    maxSizeBytes: r.max_size_bytes,
    wajibUntuk: parseWajib(r.wajib),
    updatedAt: r.updated_at,
  };
}

export async function listJenis(env: Bindings): Promise<AdminJenisResponse> {
  const { results } = await selectAllJenis(env.DB).all<JenisRow>();
  return { items: (results ?? []).map(toJenis) };
}

export async function createJenis(
  env: Bindings,
  auth: AuthContext,
  body: unknown,
  meta: RequestMeta,
): Promise<{ item: AdminJenisDokumen }> {
  const v = parseWith(createJenisSchema, body);
  const db = env.DB;
  const nowIso = toIso(meta.nowMs);
  let results: D1Result[];
  try {
    // Plain INSERTs: a duplicate id fails the PK and rolls back the matrix + audit too.
    results = await db.batch([
      insertJenis(db, {
        id: v.id,
        nama: v.nama,
        kategori: v.kategori,
        urutan: v.urutan,
        aktif: v.aktif ? 1 : 0,
        max_size_bytes: v.maxSizeBytes,
        updated_at: nowIso,
      }),
      insertWajib(db, v.id, v.wajibUntuk),
      auditStatement(db, {
        ts: nowIso,
        actor: actor(auth),
        action: 'JENIS_DOKUMEN_CREATE',
        targetType: 'jenis_dokumen',
        targetId: v.id,
        description: `Tambah jenis dokumen: ${fieldList(v)}`,
        result: 'SUCCESS',
        ip: meta.ip,
      }),
      selectJenis(db, v.id),
    ]);
  } catch (err) {
    if (isUniqueError(err)) throw errors.conflict(MSG.jenisIdTaken, 'id');
    throw err;
  }
  const row = first<JenisRow>(results[3]);
  if (!row) throw new Error('jenis insert not visible');
  return { item: toJenis(row) };
}

export async function updateJenis(
  env: Bindings,
  auth: AuthContext,
  idParam: string,
  body: unknown,
  meta: RequestMeta,
): Promise<{ item: AdminJenisDokumen }> {
  if (!JENIS_ID_PARAM.test(idParam) || idParam.length > 64) throw errors.notFound(MSG.jenisNotFound);
  const v = parseWith(updateJenisSchema, body);
  const db = env.DB;
  const current = await selectJenis(db, idParam).first<JenisRow>();
  if (!current) throw errors.notFound(MSG.jenisNotFound);
  const oldStamp = current.updated_at;
  if (v.expectedUpdatedAt !== undefined && v.expectedUpdatedAt !== oldStamp) throw errors.conflict(MSG.stale, 'stale');

  // Strictly monotonic stamp, even within the same millisecond as the previous write.
  const prevMs = Date.parse(oldStamp);
  const newStamp = toIso(Math.max(meta.nowMs, Number.isFinite(prevMs) ? prevMs + 1 : meta.nowMs));
  const nowIso = toIso(meta.nowMs);

  // Matrix statements first, all gated on the stamp we read (see db/administrasi.ts):
  // a stale request deletes nothing, inserts nothing, updates nothing and logs nothing.
  const stmts: D1PreparedStatement[] = [];
  if (v.wajibUntuk !== undefined) {
    stmts.push(deleteWajibIfStamp(db, idParam, oldStamp), insertWajibIfStamp(db, idParam, oldStamp, v.wajibUntuk));
  }
  const updateIdx = stmts.length;
  stmts.push(
    updateJenisIfStamp(db, idParam, oldStamp, newStamp, {
      nama: v.nama ?? null,
      kategori: v.kategori ?? null,
      urutan: v.urutan ?? null,
      aktif: boolInt(v.aktif),
      maxSizeBytes: v.maxSizeBytes ?? null,
    }),
    auditStatement(
      db,
      {
        ts: nowIso,
        actor: actor(auth),
        action: 'JENIS_DOKUMEN_UPDATE',
        targetType: 'jenis_dokumen',
        targetId: idParam,
        description: `Ubah jenis dokumen: ${fieldList(v, ['expectedUpdatedAt'])}`,
        result: 'SUCCESS',
        ip: meta.ip,
      },
      { onlyIfPreviousChanged: true },
    ),
    selectJenis(db, idParam),
  );
  const results = await db.batch(stmts);
  const row = first<JenisRow>(results[updateIdx + 2]);
  if (!row) throw errors.notFound(MSG.jenisNotFound);
  if ((results[updateIdx]?.meta.changes ?? 0) !== 1) throw errors.conflict(MSG.stale, 'stale');
  return { item: toJenis(row) };
}
