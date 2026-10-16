// Phase 6: admin Master Data Pegawai — list, detail, create, edit (Part A); account actions,
// soft delete / restore and the admin dashboard (Part B). Contract: shared/pegawai.ts.
import { RETENTION, type Role } from '../../shared/enums';
import {
  createPegawaiSchema,
  pegawaiListQuerySchema,
  setStatusAkunSchema,
  updatePegawaiSchema,
  type AccountActionResponse,
  type AdminDashboardResponse,
  type DeletePegawaiResponse,
  type PegawaiDetailResponse,
  type PegawaiListItem,
  type PegawaiListResponse,
} from '../../shared/pegawai';
import { defaultPasswordFor } from '../../shared/validators';
import { selectCurrentPangkat, selectPangkat, selectUnit } from '../db/pengajuan';
import {
  cancelPendingAfterDelete,
  countActiveAdminsExcludingStmt,
  countActiveSessions,
  dashboardDokumenStmt,
  dashboardPegawaiStmt,
  latestAktivitasStmt,
  listStatements,
  otherActiveAdminExistsSql,
  resetPasswordStmt,
  restoreNikConflict,
  restorePegawai,
  revokeSessionsAfterDelete,
  revokeSessionsAfterReset,
  revokeSessionsIfNonaktif,
  rowToListItem,
  selectActiveNip,
  selectAkun,
  selectListItemById,
  selectNipOwner,
  selectRestorable,
  softDeletePegawai,
  unlockAkun,
  updateStatusAkun,
  type AktivitasRow,
  type AkunRow,
  type DashboardDokumenRow,
  type DashboardPegawaiRow,
  type PegawaiListRow,
  type PegawaiSummaryRow,
} from '../db/pegawai';
import {
  KEPEGAWAIAN_COLUMN_MAP,
  nikUsedByOther,
  pendidikanExists,
  PROFILE_COLUMN_MAP,
  rowToPendingPengajuan,
  rowToProfile,
  selectPegawaiById,
  selectPendingPengajuan,
  type PegawaiRow,
  type PengajuanRow,
} from '../db/profile';
import type { AuthContext, Bindings } from '../env';
import { auditStatement, type AuditActor } from '../lib/audit';
import { hashPassword } from '../lib/crypto';
import { ApiError, errors } from '../lib/errors';
import { toIso } from '../lib/time';
import { parseWith } from '../lib/validation';
import type { RequestMeta } from './auth';
import { parseId } from './dokumen';
import { pangkatStatusIssue, PANGKAT_ISSUE_MESSAGES } from './pengajuan';

export const MSG_PEGAWAI_NOT_FOUND = 'Pegawai tidak ditemukan.';
export const MSG_LAST_ADMIN = 'Harus ada minimal satu Admin aktif.';
const MSG_NIK_CONFLICT = 'NIK sudah terdaftar pada pegawai lain.';
const MSG_NIP_CONFLICT = 'NIP sudah terdaftar.';
const MSG_NIP_DELETED = 'NIP ini milik pegawai yang dihapus. Pulihkan dari tab Terhapus.';
/** Retention over but the purge cron has not run yet: restore is no longer possible. */
const MSG_NIP_PURGING = 'NIP ini milik pegawai yang sedang dihapus permanen. Coba lagi besok.';
const MSG_STALE = 'Data pegawai telah diubah. Muat ulang sebelum menyimpan.';
const MSG_SELF_ROLE = 'Anda tidak dapat mengubah peran akun sendiri.';

/** Fixed whitelist of writable columns: camelCase key → snake_case column. */
const WRITABLE_COLUMN_MAP = {
  nama: 'nama',
  role: 'role',
  ...KEPEGAWAIAN_COLUMN_MAP,
  ...PROFILE_COLUMN_MAP,
} as const;
type WritableKey = keyof typeof WRITABLE_COLUMN_MAP;
const WRITABLE_KEYS = Object.keys(WRITABLE_COLUMN_MAP) as WritableKey[];

export function actorOf(auth: AuthContext): AuditActor {
  const u = auth.user;
  return { id: u.id, nip: u.nip, nama: u.nama, role: u.role };
}

/** Path id → number; malformed ids are "not found". */
export function parsePegawaiId(raw: string | undefined): number {
  const id = parseId(raw);
  if (id === null) throw errors.notFound(MSG_PEGAWAI_NOT_FOUND);
  return id;
}

function first<T>(res: D1Result | undefined): T | null {
  return (res?.results?.[0] as T | undefined) ?? null;
}

function uniqueErrorColumn(err: unknown): 'nip' | 'nik' | null {
  const msg = err instanceof Error ? err.message : String(err);
  if (!/UNIQUE constraint failed/i.test(msg)) return null;
  if (/pegawai\.nip/i.test(msg)) return 'nip';
  if (/pegawai\.nik/i.test(msg)) return 'nik';
  return null;
}

// ---------------------------------------------------------------------------
// GET /api/admin/pegawai
// ---------------------------------------------------------------------------

export async function listPegawai(env: Bindings, query: unknown, meta: RequestMeta): Promise<PegawaiListResponse> {
  const qp = parseWith(pegawaiListQuerySchema, query);
  const nowIso = toIso(meta.nowMs);
  const db = env.DB;
  const [itemsRes, totalRes, summaryRes] = await db.batch(
    listStatements(
      db,
      {
        scope: qp.terhapus ? 'deleted' : 'active',
        q: qp.q || undefined,
        statusKepegawaian: qp.statusKepegawaian,
        statusAkun: qp.statusAkun,
        kelengkapan: qp.kelengkapan,
        belumUnggah: qp.belumUnggah || undefined,
        passwordDefault: qp.passwordDefault,
      },
      qp.sort,
      qp.dir,
      qp.pageSize,
      (qp.page - 1) * qp.pageSize,
      nowIso,
    ),
  );
  const s = first<PegawaiSummaryRow>(summaryRes);
  return {
    items: ((itemsRes?.results ?? []) as PegawaiListRow[]).map(rowToListItem),
    page: qp.page,
    pageSize: qp.pageSize,
    total: first<{ n: number }>(totalRes)?.n ?? 0,
    summary: {
      total: s?.total ?? 0,
      aktif: s?.aktif ?? 0,
      nonaktif: s?.nonaktif ?? 0,
      passwordDefault: s?.password_default ?? 0,
      terhapus: s?.terhapus ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// GET /api/admin/pegawai/:id
// ---------------------------------------------------------------------------

/** Batchable statements for {@link detailFromResults}: row, akun, active sessions, pending pengajuan. */
export function detailStatements(db: D1Database, id: number, nowIso: string): D1PreparedStatement[] {
  return [
    selectPegawaiById(db, id),
    selectAkun(db, id),
    countActiveSessions(db, id, nowIso),
    selectPendingPengajuan(db, id),
  ];
}

/** Build the detail from the 4 results of {@link detailStatements}; null when deleted/unknown. */
export function detailFromResults(results: (D1Result | undefined)[], nowIso: string): PegawaiDetailResponse | null {
  const row = first<PegawaiRow>(results[0]);
  if (!row) return null;
  const akun = first<AkunRow>(results[1]);
  const pRow = first<PengajuanRow>(results[3]);
  const lockedUntil = akun?.locked_until ?? null;
  return {
    pegawai: rowToProfile(row),
    akun: {
      isDefaultPassword: akun?.is_default_password === 1,
      terkunci: lockedUntil !== null && lockedUntil > nowIso,
      lockedUntil,
      lastLoginAt: akun?.last_login_at ?? null,
      passwordChangedAt: akun?.password_changed_at ?? null,
      sesiAktif: first<{ n: number }>(results[2])?.n ?? 0,
    },
    pengajuanAktif: pRow ? rowToPendingPengajuan(pRow) : null,
  };
}

export async function getPegawaiDetail(
  env: Bindings,
  rawId: string | undefined,
  meta: RequestMeta,
): Promise<PegawaiDetailResponse> {
  const id = parsePegawaiId(rawId);
  const nowIso = toIso(meta.nowMs);
  const detail = detailFromResults(await env.DB.batch(detailStatements(env.DB, id, nowIso)), nowIso);
  if (!detail) throw errors.notFound(MSG_PEGAWAI_NOT_FOUND);
  return detail;
}

// ---------------------------------------------------------------------------
// Reference validation (shared by create and update)
// ---------------------------------------------------------------------------

interface RefInput {
  statusKepegawaian?: PegawaiRow['status_kepegawaian'];
  pangkatKode?: string | null;
  unitId?: number | null;
  pendidikanKode?: string | null;
  nik?: string | null;
}

type RefKind = 'pangkat' | 'unit' | 'pendidikan' | 'nik';
interface RefChecks {
  stmts: D1PreparedStatement[];
  /** Index of each requested check inside `stmts`. */
  slots: Partial<Record<RefKind, number>>;
}

/** Only the checks the input needs, in a fixed order. */
function refChecks(db: D1Database, input: RefInput, selfId: number): RefChecks {
  const out: RefChecks = { stmts: [], slots: {} };
  const add = (kind: RefKind, s: D1PreparedStatement) => {
    out.slots[kind] = out.stmts.length;
    out.stmts.push(s);
  };
  if (input.pangkatKode != null) add('pangkat', selectPangkat(db, input.pangkatKode));
  if (input.unitId != null) add('unit', selectUnit(db, input.unitId));
  if (input.pendidikanKode != null) add('pendidikan', pendidikanExists(db, input.pendidikanKode));
  if (input.nik != null) add('nik', nikUsedByOther(db, input.nik, selfId));
  return out;
}

/**
 * Validate references from batch results (`offset` = where the refChecks statements start).
 * Pangkat is checked against the EFFECTIVE status (input merged with current values), the
 * same rule as pengajuan. Throws 400 (field errors) or 409 (NIK).
 */
function checkRefs(
  input: RefInput,
  checks: RefChecks,
  results: D1Result[],
  offset: number,
  current: { status: PegawaiRow['status_kepegawaian']; pangkat: { jenis_asn: 'PNS' | 'PPPK' } | null },
): void {
  const res = (kind: RefKind): unknown[] => {
    const idx = checks.slots[kind];
    return idx === undefined ? [] : (results[offset + idx]?.results ?? []);
  };
  const fieldErrors: Record<string, string> = {};
  const pangkatRef = (res('pangkat')[0] as { jenis_asn: 'PNS' | 'PPPK' } | undefined) ?? null;
  const issue = pangkatStatusIssue({
    desiredStatus: input.statusKepegawaian ?? undefined,
    desiredPangkat: input.pangkatKode,
    currentStatus: current.status,
    pangkatRef,
    currentPangkat: current.pangkat,
  });
  if (issue) fieldErrors.pangkatKode = PANGKAT_ISSUE_MESSAGES[issue];
  if (input.unitId != null && res('unit').length === 0) fieldErrors.unitId = 'Unit organisasi tidak valid.';
  if (input.pendidikanKode != null && res('pendidikan').length === 0) fieldErrors.pendidikanKode = 'Pendidikan tidak valid.';
  if (Object.keys(fieldErrors).length) throw errors.validation(fieldErrors);
  if (input.nik != null && res('nik').length > 0) throw errors.conflict(MSG_NIK_CONFLICT, 'nik');
}

// ---------------------------------------------------------------------------
// POST /api/admin/pegawai
// ---------------------------------------------------------------------------

export async function createPegawai(
  env: Bindings,
  auth: AuthContext,
  body: unknown,
  meta: RequestMeta,
): Promise<PegawaiDetailResponse> {
  const input = parseWith(createPegawaiSchema, body);
  const db = env.DB;
  const rec = input as unknown as Record<string, unknown>;

  // Round trip 1: NIP owner (all rows) + reference/NIK checks.
  const checks = refChecks(db, input, 0);
  const pre = await db.batch([selectNipOwner(db, input.nip), ...checks.stmts]);
  const nowIso = toIso(meta.nowMs);
  const owner = first<{ id: number; deleted_at: string | null; purge_after: string | null }>(pre[0]);
  if (owner) {
    const message = !owner.deleted_at
      ? MSG_NIP_CONFLICT
      : owner.purge_after && owner.purge_after > nowIso
        ? MSG_NIP_DELETED
        : MSG_NIP_PURGING;
    throw errors.conflict(message, 'nip');
  }
  checkRefs(input, checks, pre, 1, { status: null, pangkat: null });

  const passwordHash = await hashPassword(defaultPasswordFor(input.nip), env.PASSWORD_PEPPER);

  // Columns come ONLY from the fixed whitelist map; nip is set explicitly.
  const keys = WRITABLE_KEYS.filter((k) => rec[k] !== undefined);
  const cols = ['nip', ...keys.map((k) => WRITABLE_COLUMN_MAP[k]), 'created_at', 'updated_at'];
  const values = [input.nip, ...keys.map((k) => rec[k] ?? null), nowIso, nowIso];
  const placeholders = values.map((_, i) => `?${i + 1}`);
  const insert = db
    .prepare(`INSERT INTO pegawai (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`)
    .bind(...values);

  let results: D1Result[];
  try {
    results = await db.batch([
      insert,
      auditStatement(
        db,
        {
          ts: nowIso,
          actor: actorOf(auth),
          action: 'PEGAWAI_CREATE',
          targetType: 'pegawai',
          // No PII: field names and enum values only.
          description: `Pegawai dibuat (peran ${input.role}, status ${input.statusKepegawaian}); data: ${keys.join(', ')}`,
          result: 'SUCCESS',
          ip: meta.ip,
        },
        { targetIdFromLastInsert: true },
      ),
      db
        .prepare(
          `INSERT INTO akun (pegawai_id, password_hash, is_default_password)
           SELECT id, ?2, 1 FROM pegawai WHERE nip = ?1`,
        )
        .bind(input.nip, passwordHash),
    ]);
  } catch (err) {
    const col = uniqueErrorColumn(err);
    if (col === 'nip') throw errors.conflict(MSG_NIP_CONFLICT, 'nip');
    if (col === 'nik') throw errors.conflict(MSG_NIK_CONFLICT, 'nik');
    throw err;
  }
  const row = first<PegawaiRow>(results[0]);
  if (!row) throw new Error('pegawai insert returned no row');
  return {
    pegawai: rowToProfile(row),
    akun: {
      isDefaultPassword: true,
      terkunci: false,
      lockedUntil: null,
      lastLoginAt: null,
      passwordChangedAt: null,
      sesiAktif: 0,
    },
    pengajuanAktif: null,
  };
}

// ---------------------------------------------------------------------------
// PATCH /api/admin/pegawai/:id
// ---------------------------------------------------------------------------

export async function updatePegawai(
  env: Bindings,
  auth: AuthContext,
  rawId: string | undefined,
  body: unknown,
  meta: RequestMeta,
): Promise<PegawaiDetailResponse> {
  const id = parsePegawaiId(rawId);
  const input = parseWith(updatePegawaiSchema, body);
  const rec = input as unknown as Record<string, unknown>;
  const keys = WRITABLE_KEYS.filter((k) => rec[k] !== undefined);
  if (keys.length === 0) throw errors.validation({ _form: 'Tidak ada perubahan.' });

  const self = id === auth.user.id;
  if (self && input.role !== undefined && input.role !== auth.user.role) {
    throw new ApiError(403, 'FORBIDDEN', MSG_SELF_ROLE);
  }

  const db = env.DB;
  const checks = refChecks(db, input, id);
  // Round trip 1: current row, its current pangkat, other active admins, reference checks.
  const pre = await db.batch([
    selectPegawaiById(db, id),
    selectCurrentPangkat(db, id),
    countActiveAdminsExcludingStmt(db, id),
    ...checks.stmts,
  ]);
  const row = first<PegawaiRow>(pre[0]);
  if (!row) throw errors.notFound(MSG_PEGAWAI_NOT_FOUND);
  const currentPangkat = first<{ jenis_asn: 'PNS' | 'PPPK' }>(pre[1]);
  const otherAdmins = first<{ n: number }>(pre[2])?.n ?? 0;

  const roleChanged = input.role !== undefined && input.role !== row.role;
  const demotesActiveAdmin = roleChanged && row.role === 'Admin' && row.status_akun === 'Aktif';
  if (demotesActiveAdmin && otherAdmins === 0) throw errors.conflict(MSG_LAST_ADMIN);
  if (input.expectedUpdatedAt !== undefined && input.expectedUpdatedAt !== row.updated_at) {
    throw errors.conflict(MSG_STALE, 'stale');
  }
  checkRefs(input, checks, pre, 3, { status: row.status_kepegawaian, pangkat: currentPangkat });

  const nowIso = toIso(meta.nowMs);
  // ?1 id, ?2 expectedUpdatedAt, ?3 now, then values. Column names from the fixed map only.
  const sets = keys.map((k, i) => `${WRITABLE_COLUMN_MAP[k]} = ?${i + 4}`);
  sets.push('updated_at = ?3');
  const guards = ['id = ?1', 'deleted_at IS NULL', '(?2 IS NULL OR updated_at = ?2)'];
  // Atomic last-admin rule, evaluated on the row's CURRENT state (not the earlier read): if the
  // target is an active Admin at write time — e.g. reactivated concurrently — demoting it
  // still requires another active admin.
  if (roleChanged && input.role !== 'Admin') {
    guards.push(`(role <> 'Admin' OR status_akun <> 'Aktif' OR ${otherActiveAdminExistsSql('?1')})`);
  }
  const update = db
    .prepare(`UPDATE pegawai SET ${sets.join(', ')} WHERE ${guards.join(' AND ')}`)
    .bind(id, input.expectedUpdatedAt ?? null, nowIso, ...keys.map((k) => rec[k] ?? null));

  const stmts: D1PreparedStatement[] = [
    update,
    auditStatement(
      db,
      {
        ts: nowIso,
        actor: actorOf(auth),
        action: 'PEGAWAI_UPDATE',
        targetType: 'pegawai',
        targetId: id,
        // Field names only; values (NIK, phone, …) are personal data and never logged.
        description: `Data pegawai diperbarui: ${keys.join(', ')}`,
        result: 'SUCCESS',
        ip: meta.ip,
      },
      { onlyIfPreviousChanged: true },
    ),
  ];
  if (roleChanged) {
    // Privileges changed: drop the target's sessions, only if THIS update applied.
    stmts.push(
      db
        .prepare(
          `DELETE FROM sesi WHERE pegawai_id = ?1
              AND EXISTS (SELECT 1 FROM pegawai WHERE id = ?1 AND updated_at = ?2 AND role = ?3)`,
        )
        .bind(id, nowIso, input.role as Role),
    );
  }
  const detailAt = stmts.length;
  stmts.push(...detailStatements(db, id, nowIso));

  let results: D1Result[];
  try {
    results = await db.batch(stmts);
  } catch (err) {
    if (uniqueErrorColumn(err) === 'nik') throw errors.conflict(MSG_NIK_CONFLICT, 'nik');
    throw err;
  }
  const detail = detailFromResults(results.slice(detailAt), nowIso);
  if ((results[0]?.meta.changes ?? 0) !== 1) {
    if (!detail) throw errors.notFound(MSG_PEGAWAI_NOT_FOUND);
    const demotionRefused = roleChanged && input.role !== 'Admin' && detail.pegawai.role === 'Admin';
    if (demotionRefused && (input.expectedUpdatedAt === undefined || detail.pegawai.updatedAt === input.expectedUpdatedAt)) {
      throw errors.conflict(MSG_LAST_ADMIN);
    }
    throw errors.conflict(MSG_STALE, 'stale');
  }
  if (!detail) throw errors.notFound(MSG_PEGAWAI_NOT_FOUND);
  return detail;
}

// ===========================================================================
// Part B: account actions, soft delete / restore, admin dashboard
// ===========================================================================

const MSG_SELF_DEACTIVATE = 'Anda tidak dapat menonaktifkan akun sendiri.';
const MSG_SELF_RESET = 'Gunakan Pengaturan Akun untuk mengganti password Anda.';
const MSG_SELF_DELETE = 'Anda tidak dapat menghapus akun sendiri.';
const MSG_RESTORE_NIK = 'NIK pegawai ini sudah dipakai pegawai lain.';

function forbidden(message: string): ApiError {
  return new ApiError(403, 'FORBIDDEN', message);
}

/** Changes reported by statement `i` of a batch. */
function changesAt(results: D1Result[], i: number): number {
  return results[i]?.meta.changes ?? 0;
}

function itemAt(results: D1Result[], i: number): PegawaiListItem | null {
  const row = first<PegawaiListRow>(results[i]);
  return row ? rowToListItem(row) : null;
}

// ---------------------------------------------------------------------------
// POST /api/admin/pegawai/:id/status
// ---------------------------------------------------------------------------

/**
 * Idempotent: setting the state the account already has is a 200 with no audit row.
 * Repeating Nonaktif still sweeps any stray session (the revoke is guarded by the
 * post-condition `status_akun = 'Nonaktif'`, not by this request having changed the row).
 */
export async function setStatusAkun(
  env: Bindings,
  auth: AuthContext,
  rawId: string | undefined,
  body: unknown,
  meta: RequestMeta,
): Promise<AccountActionResponse> {
  const id = parsePegawaiId(rawId);
  const { statusAkun } = parseWith(setStatusAkunSchema, body);
  if (id === auth.user.id && statusAkun === 'Nonaktif') throw forbidden(MSG_SELF_DEACTIVATE);

  const db = env.DB;
  const nowIso = toIso(meta.nowMs);
  const deactivate = statusAkun === 'Nonaktif';
  const stmts: D1PreparedStatement[] = [
    updateStatusAkun(db, id, statusAkun, nowIso),
    // Must directly follow the UPDATE: `changes()` refers to the previous statement.
    auditStatement(
      db,
      {
        ts: nowIso,
        actor: actorOf(auth),
        action: deactivate ? 'PEGAWAI_DEACTIVATE' : 'PEGAWAI_REACTIVATE',
        targetType: 'pegawai',
        targetId: id,
        description: deactivate ? 'Akun pegawai dinonaktifkan' : 'Akun pegawai diaktifkan kembali',
        result: 'SUCCESS',
        ip: meta.ip,
      },
      { onlyIfPreviousChanged: true },
    ),
  ];
  if (deactivate) stmts.push(revokeSessionsIfNonaktif(db, id));
  const itemIdx = stmts.length;
  stmts.push(selectListItemById(db, id, nowIso));

  const results = await db.batch(stmts);
  const item = itemAt(results, itemIdx);
  if (!item || item.deleted) throw errors.notFound(MSG_PEGAWAI_NOT_FOUND);
  // 0 changes and still not in the requested state: only the last-admin guard can refuse.
  if (changesAt(results, 0) !== 1 && item.statusAkun !== statusAkun) throw errors.conflict(MSG_LAST_ADMIN);
  return { item, revokedSessions: deactivate ? changesAt(results, 2) : 0 };
}

// ---------------------------------------------------------------------------
// POST /api/admin/pegawai/:id/reset-password
// ---------------------------------------------------------------------------

/** Not idempotent by design: every call issues a fresh hash, revokes sessions and is audited. */
export async function resetPassword(
  env: Bindings,
  auth: AuthContext,
  rawId: string | undefined,
  meta: RequestMeta,
): Promise<AccountActionResponse> {
  const id = parsePegawaiId(rawId);
  if (id === auth.user.id) throw forbidden(MSG_SELF_RESET);

  const db = env.DB;
  const target = await selectActiveNip(db, id).first<{ nip: string }>();
  if (!target) throw errors.notFound(MSG_PEGAWAI_NOT_FOUND);
  // The only PBKDF2 of this request (CPU budget).
  const passwordHash = await hashPassword(defaultPasswordFor(target.nip), env.PASSWORD_PEPPER);
  const nowIso = toIso(meta.nowMs);

  const results = await db.batch([
    resetPasswordStmt(db, id, target.nip, passwordHash, nowIso),
    auditStatement(
      db,
      {
        ts: nowIso,
        actor: actorOf(auth),
        action: 'PASSWORD_RESET',
        targetType: 'pegawai',
        targetId: id,
        description: 'Password pegawai direset ke default',
        result: 'SUCCESS',
        ip: meta.ip,
      },
      { onlyIfPreviousChanged: true },
    ),
    revokeSessionsAfterReset(db, id, passwordHash),
    selectListItemById(db, id, nowIso),
  ]);
  const item = itemAt(results, 3);
  if (changesAt(results, 0) !== 1 || !item || item.deleted) throw errors.notFound(MSG_PEGAWAI_NOT_FOUND);
  return { item, revokedSessions: changesAt(results, 2) };
}

// ---------------------------------------------------------------------------
// POST /api/admin/pegawai/:id/unlock
// ---------------------------------------------------------------------------

/** Idempotent: an account that is not locked (and has no failed attempts) is a 200 without audit. */
export async function unlockAccount(
  env: Bindings,
  auth: AuthContext,
  rawId: string | undefined,
  meta: RequestMeta,
): Promise<AccountActionResponse> {
  const id = parsePegawaiId(rawId);
  const db = env.DB;
  const nowIso = toIso(meta.nowMs);
  const results = await db.batch([
    unlockAkun(db, id),
    auditStatement(
      db,
      {
        ts: nowIso,
        actor: actorOf(auth),
        action: 'ACCOUNT_UNLOCK',
        targetType: 'pegawai',
        targetId: id,
        description: 'Kunci akun pegawai dibuka',
        result: 'SUCCESS',
        ip: meta.ip,
      },
      { onlyIfPreviousChanged: true },
    ),
    selectListItemById(db, id, nowIso),
  ]);
  const item = itemAt(results, 2);
  if (!item || item.deleted) throw errors.notFound(MSG_PEGAWAI_NOT_FOUND);
  return { item, revokedSessions: 0 };
}

// ---------------------------------------------------------------------------
// DELETE /api/admin/pegawai/:id
// ---------------------------------------------------------------------------

/** Not idempotent: a second delete is a 404 (contract). Documents and R2 objects are untouched. */
export async function softDelete(
  env: Bindings,
  auth: AuthContext,
  rawId: string | undefined,
  meta: RequestMeta,
): Promise<DeletePegawaiResponse> {
  const id = parsePegawaiId(rawId);
  if (id === auth.user.id) throw forbidden(MSG_SELF_DELETE);

  const db = env.DB;
  const nowIso = toIso(meta.nowMs);
  const purgeAfter = toIso(meta.nowMs + RETENTION.pegawaiSoftDeleteDays * 86_400_000);
  const results = await db.batch([
    softDeletePegawai(db, id, auth.user.id, nowIso, purgeAfter),
    auditStatement(
      db,
      {
        ts: nowIso,
        actor: actorOf(auth),
        action: 'PEGAWAI_DELETE',
        targetType: 'pegawai',
        targetId: id,
        description: `Pegawai dihapus (dapat dipulihkan ${RETENTION.pegawaiSoftDeleteDays} hari)`,
        result: 'SUCCESS',
        ip: meta.ip,
      },
      { onlyIfPreviousChanged: true },
    ),
    // Both guarded by the post-condition deleted_at = this request's timestamp.
    revokeSessionsAfterDelete(db, id, nowIso),
    cancelPendingAfterDelete(db, id, nowIso),
    selectListItemById(db, id, nowIso),
  ]);
  if (changesAt(results, 0) !== 1) {
    const item = itemAt(results, 4);
    if (!item || item.deleted) throw errors.notFound(MSG_PEGAWAI_NOT_FOUND);
    throw errors.conflict(MSG_LAST_ADMIN);
  }
  return { purgeAfter };
}

// ---------------------------------------------------------------------------
// POST /api/admin/pegawai/:id/restore
// ---------------------------------------------------------------------------

/** A concurrent restore that already won returns 200 with the restored item (no second audit). */
export async function restore(
  env: Bindings,
  auth: AuthContext,
  rawId: string | undefined,
  meta: RequestMeta,
): Promise<AccountActionResponse> {
  const id = parsePegawaiId(rawId);
  const db = env.DB;
  const nowIso = toIso(meta.nowMs);

  const [restorable, nik] = await db.batch([selectRestorable(db, id, nowIso), restoreNikConflict(db, id)]);
  if (!first(restorable)) throw errors.notFound(MSG_PEGAWAI_NOT_FOUND);
  if (first(nik)) throw errors.conflict(MSG_RESTORE_NIK, 'nik');

  const results = await db.batch([
    restorePegawai(db, id, nowIso),
    auditStatement(
      db,
      {
        ts: nowIso,
        actor: actorOf(auth),
        action: 'PEGAWAI_RESTORE',
        targetType: 'pegawai',
        targetId: id,
        description: 'Pegawai dipulihkan dari tab Terhapus',
        result: 'SUCCESS',
        ip: meta.ip,
      },
      { onlyIfPreviousChanged: true },
    ),
    selectListItemById(db, id, nowIso),
  ]);
  const item = itemAt(results, 2);
  if (!item) throw errors.notFound(MSG_PEGAWAI_NOT_FOUND);
  if (item.deleted) {
    // Guard refused between the pre-check and the update: retention ended or NIK now taken.
    if (item.deleted.purgeAfter <= nowIso) throw errors.notFound(MSG_PEGAWAI_NOT_FOUND);
    throw errors.conflict(MSG_RESTORE_NIK, 'nik');
  }
  return { item, revokedSessions: 0 };
}

// ---------------------------------------------------------------------------
// GET /api/admin/dashboard
// ---------------------------------------------------------------------------

const AKTIVITAS_LIMIT = 7;

export async function getAdminDashboard(env: Bindings): Promise<AdminDashboardResponse> {
  const db = env.DB;
  const [pRes, dRes, aRes] = await db.batch([
    dashboardPegawaiStmt(db),
    dashboardDokumenStmt(db),
    latestAktivitasStmt(db, AKTIVITAS_LIMIT),
  ]);
  const p = first<DashboardPegawaiRow>(pRes);
  const d = first<DashboardDokumenRow>(dRes);
  const wajib = d?.wajib ?? 0;
  return {
    pegawai: {
      total: p?.total ?? 0,
      aktif: p?.aktif ?? 0,
      nonaktif: p?.nonaktif ?? 0,
      perStatus: {
        PNS: p?.pns ?? 0,
        CPNS: p?.cpns ?? 0,
        PPPK: p?.pppk ?? 0,
        'Belum diisi': p?.belum_diisi ?? 0,
      },
      passwordDefault: p?.password_default ?? 0,
    },
    dokumen: {
      menunggu: d?.menunggu ?? 0,
      persenKelengkapan: wajib ? Math.round(((d?.verified ?? 0) / wajib) * 100) : 0,
      perKelengkapan: {
        Lengkap: d?.lengkap ?? 0,
        'Belum Lengkap': d?.belum_lengkap ?? 0,
        'Perlu Revisi': d?.perlu_revisi ?? 0,
      },
    },
    pengajuanMenunggu: d?.pengajuan_menunggu ?? 0,
    aktivitasTerbaru: ((aRes?.results ?? []) as AktivitasRow[]).map((r) => ({
      id: r.id,
      ts: r.ts,
      actorNama: r.actor_nama,
      action: r.action,
      description: r.description,
      result: r.result,
    })),
  };
}
