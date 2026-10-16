// Pengajuan perubahan data kepegawaian (owner decision #6): employees request
// employment-data changes; an admin (never the requester) approves or rejects.
import type { StatusKepegawaian, StatusPengajuan } from '../../shared/enums';
import {
  adminPengajuanQuerySchema,
  createPengajuanRequestSchema,
  KEPEGAWAIAN_FIELDS,
  rejectPengajuanRequestSchema,
  reviewPengajuanRequestSchema,
  type AdminPengajuanListResponse,
  type KepegawaianField,
  type KepegawaianValue,
  type Pengajuan,
  type PerubahanMap,
} from '../../shared/profile';
import {
  applyApprovedPerubahan,
  cancelPengajuan,
  countPengajuanByStatus,
  insertPengajuan,
  reviewPengajuan,
  rowToPengajuan,
  selectAdminPengajuan,
  selectCurrentPangkat,
  selectOwnPengajuan,
  selectOwnPengajuanById,
  selectPangkat,
  selectPengajuanById,
  selectPengajuanForReview,
  selectReviewRefs,
  selectUnit,
  type AdminPengajuanRow,
  type PengajuanReviewRow,
  type PengajuanWithReviewerRow,
  type ReviewRefRow,
} from '../db/pengajuan';
import { KEPEGAWAIAN_COLUMN_MAP, selectPegawaiById, selectPendingPengajuan, type PegawaiRow } from '../db/profile';
import type { AuthContext, Bindings } from '../env';
import { auditStatement, type AuditActor } from '../lib/audit';
import { ApiError, errors } from '../lib/errors';
import { toIso } from '../lib/time';
import { parseWith, zodFieldErrors } from '../lib/validation';
import type { RequestMeta } from './auth';

const MSG_PENDING_EXISTS = 'Masih ada pengajuan yang menunggu verifikasi.';
const MSG_ALREADY_PROCESSED = 'Pengajuan sudah diproses.';
const MSG_NOT_FOUND = 'Pengajuan tidak ditemukan.';
const MSG_PANGKAT_MISMATCH = 'Pangkat/golongan tidak sesuai dengan status kepegawaian.';
const MSG_PANGKAT_REQUIRED = 'Pilih pangkat/golongan yang sesuai status baru.';

function actorOf(auth: AuthContext): AuditActor {
  const u = auth.user;
  return { id: u.id, nip: u.nip, nama: u.nama, role: u.role };
}

/** String-normalised comparison: null/undefined are equal to each other only. */
function norm(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}
function sameValue(a: unknown, b: unknown): boolean {
  return norm(a) === norm(b);
}

export function asnFamily(status: StatusKepegawaian): 'PNS' | 'PPPK' {
  return status === 'PPPK' ? 'PPPK' : 'PNS';
}

export const PANGKAT_ISSUE_MESSAGES = {
  mismatch: MSG_PANGKAT_MISMATCH,
  required: MSG_PANGKAT_REQUIRED,
} as const;

/**
 * Pangkat family vs status kepegawaian (CPNS/PNS → PNS list, PPPK → PPPK list), shared by
 * pengajuan and the admin Master Data form.
 *  - `desiredPangkat` string: its (active) reference must exist and fit the effective status
 *    (desired status, else current) → otherwise 'mismatch'.
 *  - `desiredPangkat` undefined while the status changes ASN family: the current pangkat must
 *    fit the new status → otherwise 'required' (the user must pick a new pangkat).
 *  - `desiredPangkat` null (clearing it) is always fine.
 */
export function pangkatStatusIssue(input: {
  desiredStatus: StatusKepegawaian | undefined;
  desiredPangkat: string | null | undefined;
  currentStatus: StatusKepegawaian | null;
  /** Active reference row for `desiredPangkat` (null when missing/inactive or not requested). */
  pangkatRef: { jenis_asn: 'PNS' | 'PPPK' } | null;
  /** Reference row of the CURRENT pangkat (null when none). */
  currentPangkat: { jenis_asn: 'PNS' | 'PPPK' } | null;
}): keyof typeof PANGKAT_ISSUE_MESSAGES | null {
  const { desiredStatus, desiredPangkat, currentStatus, pangkatRef, currentPangkat } = input;
  const effectiveStatus = desiredStatus ?? currentStatus;
  if (desiredPangkat !== null && desiredPangkat !== undefined) {
    if (!pangkatRef || (effectiveStatus && pangkatRef.jenis_asn !== asnFamily(effectiveStatus))) return 'mismatch';
    return null;
  }
  if (
    desiredStatus !== undefined &&
    desiredPangkat === undefined &&
    (currentStatus === null || asnFamily(currentStatus) !== asnFamily(desiredStatus)) &&
    currentPangkat &&
    currentPangkat.jenis_asn !== asnFamily(desiredStatus)
  ) {
    return 'required';
  }
  return null;
}

function currentValue(row: Record<string, unknown>, field: KepegawaianField): KepegawaianValue {
  const v = row[KEPEGAWAIAN_COLUMN_MAP[field]];
  return v === undefined ? null : (v as KepegawaianValue);
}

function parseId(raw: string): number {
  if (!/^[1-9]\d{0,15}$/.test(raw)) throw errors.notFound(MSG_NOT_FOUND);
  const id = Number(raw);
  if (!Number.isSafeInteger(id)) throw errors.notFound(MSG_NOT_FOUND);
  return id;
}

function isPendingUniqueError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed/i.test(msg) && /pengajuan_perubahan/i.test(msg);
}

function first<T>(res: D1Result | undefined): T | null {
  return (res?.results?.[0] as T | undefined) ?? null;
}

// ---------------------------------------------------------------------------
// POST /api/me/pengajuan
// ---------------------------------------------------------------------------

export async function createPengajuan(
  env: Bindings,
  auth: AuthContext,
  body: unknown,
  meta: RequestMeta,
): Promise<Pengajuan> {
  const parsed = createPengajuanRequestSchema.safeParse(body);
  if (!parsed.success) {
    const fields = zodFieldErrors(parsed.error);
    for (const issue of parsed.error.issues) {
      if (issue.code !== 'unrecognized_keys') continue;
      const key = issue.path.length ? issue.path.map(String).join('.') : '_form';
      fields[key] =
        key === 'perubahan'
          ? 'Hanya data kepegawaian (status, pangkat, TMT, jabatan, jenis jabatan, unit) yang dapat diajukan.'
          : 'Permintaan berisi data yang tidak dikenal.';
    }
    throw errors.validation(fields);
  }
  const { perubahan: desired, alasan } = parsed.data;
  const id = auth.user.id;
  const db = env.DB;

  // One round trip: current row, pending check, current pangkat family, and references.
  const pangkatKode = desired.pangkatKode ?? null;
  const unitId = desired.unitId ?? null;
  const stmts = [selectPegawaiById(db, id), selectPendingPengajuan(db, id), selectCurrentPangkat(db, id)];
  if (pangkatKode !== null) stmts.push(selectPangkat(db, pangkatKode));
  if (unitId !== null) stmts.push(selectUnit(db, unitId));
  const results = await db.batch(stmts);

  const row = first<PegawaiRow>(results[0]);
  if (!row) throw errors.notFound('Pegawai tidak ditemukan.');
  if (first(results[1])) throw errors.conflict(MSG_PENDING_EXISTS);
  const currentPangkat = first<{ kode: string; jenis_asn: 'PNS' | 'PPPK' }>(results[2]);
  // Optional statements were appended in order: pangkat (if any), then unit (if any).
  const pangkatRef = pangkatKode !== null ? first<{ kode: string; jenis_asn: 'PNS' | 'PPPK' }>(results[3]) : null;
  const unitRef = unitId !== null ? first<{ id: number }>(results[pangkatKode !== null ? 4 : 3]) : null;

  const fieldErrors: Record<string, string> = {};
  const pangkatIssue = pangkatStatusIssue({
    desiredStatus: desired.statusKepegawaian,
    desiredPangkat: desired.pangkatKode,
    currentStatus: row.status_kepegawaian,
    pangkatRef,
    currentPangkat,
  });
  if (pangkatIssue) fieldErrors['perubahan.pangkatKode'] = PANGKAT_ISSUE_MESSAGES[pangkatIssue];
  if (unitId !== null && !unitRef) fieldErrors['perubahan.unitId'] = 'Unit organisasi tidak valid.';
  if (Object.keys(fieldErrors).length) throw errors.validation(fieldErrors);

  const perubahan: PerubahanMap = {};
  const rowRecord = row as unknown as Record<string, unknown>;
  for (const field of KEPEGAWAIAN_FIELDS) {
    if (!(field in desired)) continue;
    const baru = (desired[field] ?? null) as KepegawaianValue;
    const lama = currentValue(rowRecord, field);
    if (!sameValue(baru, lama)) perubahan[field] = { lama, baru };
  }
  const changed = Object.keys(perubahan) as KepegawaianField[];
  if (changed.length === 0) throw errors.validation({ _form: 'Tidak ada data yang berubah.' });

  const nowIso = toIso(meta.nowMs);
  let inserted: { id: number } | null;
  try {
    const [ins] = await db.batch([
      insertPengajuan(db, id, perubahan, alasan, nowIso),
      auditStatement(db, {
        ts: nowIso,
        actor: actorOf(auth),
        action: 'PENGAJUAN_CREATE',
        targetType: 'pegawai',
        targetId: id,
        description: `Pengajuan perubahan: ${changed.join(', ')}`,
        result: 'SUCCESS',
        ip: meta.ip,
      }),
    ]);
    inserted = first<{ id: number }>(ins);
  } catch (err) {
    // uq_pengajuan_aktif: a concurrent request won between the pre-check and the insert.
    if (isPendingUniqueError(err)) throw errors.conflict(MSG_PENDING_EXISTS);
    throw err;
  }
  if (!inserted) throw new Error('pengajuan insert returned no id');

  return {
    id: inserted.id,
    pegawaiId: id,
    perubahan,
    alasan,
    status: 'Menunggu',
    catatanAdmin: null,
    createdAt: nowIso,
    reviewedAt: null,
    reviewedBy: null,
  };
}

// ---------------------------------------------------------------------------
// GET /api/me/pengajuan, DELETE /api/me/pengajuan/:id
// ---------------------------------------------------------------------------

export async function listOwnPengajuan(env: Bindings, auth: AuthContext): Promise<Pengajuan[]> {
  const { results } = await selectOwnPengajuan(env.DB, auth.user.id).all<PengajuanWithReviewerRow>();
  return results.map(rowToPengajuan);
}

export async function cancelOwnPengajuan(
  env: Bindings,
  auth: AuthContext,
  rawId: string,
  meta: RequestMeta,
): Promise<Pengajuan> {
  const pid = parseId(rawId);
  const ownerId = auth.user.id;
  const db = env.DB;
  const nowIso = toIso(meta.nowMs);
  const [upd, , sel] = await db.batch([
    cancelPengajuan(db, pid, ownerId, nowIso),
    auditStatement(
      db,
      {
        ts: nowIso,
        actor: actorOf(auth),
        action: 'PENGAJUAN_CANCEL',
        targetType: 'pengajuan',
        targetId: pid,
        description: `Pengajuan #${pid} dibatalkan`,
        result: 'SUCCESS',
        ip: meta.ip,
      },
      { onlyIfPreviousChanged: true },
    ),
    selectOwnPengajuanById(db, pid, ownerId),
  ]);
  const row = first<PengajuanWithReviewerRow>(sel);
  // Someone else's request is indistinguishable from a missing one.
  if (!row) throw errors.notFound(MSG_NOT_FOUND);
  if ((upd?.meta.changes ?? 0) !== 1) throw errors.conflict(MSG_ALREADY_PROCESSED);
  return rowToPengajuan(row);
}

// ---------------------------------------------------------------------------
// GET /api/admin/pengajuan
// ---------------------------------------------------------------------------

export async function listAdminPengajuan(env: Bindings, query: unknown): Promise<AdminPengajuanListResponse> {
  const { status } = parseWith(adminPengajuanQuerySchema, query);
  const [itemsRes, countsRes] = await env.DB.batch([
    selectAdminPengajuan(env.DB, status),
    countPengajuanByStatus(env.DB),
  ]);

  const counts: Record<StatusPengajuan, number> = { Menunggu: 0, Disetujui: 0, Ditolak: 0, Dibatalkan: 0 };
  for (const c of (countsRes?.results ?? []) as { status: StatusPengajuan; n: number }[]) {
    if (c.status in counts) counts[c.status] = c.n;
  }

  const items = ((itemsRes?.results ?? []) as AdminPengajuanRow[]).map((r) => {
    const base = rowToPengajuan(r);
    const rec = r as unknown as Record<string, unknown>;
    const stale = (Object.keys(base.perubahan) as KepegawaianField[]).some(
      (f) => KEPEGAWAIAN_FIELDS.includes(f) && !sameValue(base.perubahan[f]?.lama, currentValue(rec, f)),
    );
    return {
      ...base,
      pegawai: { id: r.pegawai_id, nip: r.pegawai_nip, nama: r.pegawai_nama, statusKepegawaian: r.status_kepegawaian },
      stale,
    };
  });
  return { items, counts };
}

// ---------------------------------------------------------------------------
// POST /api/admin/pengajuan/:id/approve | /reject
// ---------------------------------------------------------------------------

async function loadForReview(
  env: Bindings,
  auth: AuthContext,
  pid: number,
): Promise<{ row: PengajuanReviewRow; refs: ReviewRefRow[] }> {
  const [rowRes, refRes] = await env.DB.batch([
    selectPengajuanForReview(env.DB, pid),
    selectReviewRefs(env.DB, pid),
  ]);
  const row = first<PengajuanReviewRow>(rowRes);
  const refs = (refRes?.results ?? []) as ReviewRefRow[];
  if (!row) throw errors.notFound(MSG_NOT_FOUND);
  if (row.status !== 'Menunggu') throw errors.conflict(MSG_ALREADY_PROCESSED);
  // Four-eyes principle: an admin's own employment data must be verified by
  // another admin. Overrides the generic FORBIDDEN message on purpose.
  if (row.pegawai_id === auth.user.id) {
    throw new ApiError(403, 'FORBIDDEN', 'Pengajuan Anda sendiri harus diverifikasi admin lain.');
  }
  if (row.pegawai_deleted_at !== null) throw errors.conflict('Pegawai sudah dihapus.');
  return { row, refs };
}

/**
 * Re-validate against CURRENT data (the profile may have changed since submission):
 * the resulting pangkat must fit the resulting status family, and referenced
 * pangkat/unit must still be active. Other staleness is left to the admin (badge).
 */
function assertStillApplicable(
  row: PengajuanReviewRow,
  values: Partial<Record<KepegawaianField, KepegawaianValue>>,
  refs: ReviewRefRow[],
): void {
  const pangkatRef = (kode: string) => refs.find((r) => r.kind === 'pangkat' && r.ref === kode);
  if (typeof values.pangkatKode === 'string') {
    const ref = pangkatRef(values.pangkatKode);
    if (!ref || ref.aktif !== 1) {
      throw errors.conflict('Pangkat/golongan pada pengajuan sudah tidak aktif. Tolak pengajuan ini.');
    }
  }
  if (values.unitId != null) {
    const ref = refs.find((r) => r.kind === 'unit' && r.ref === String(values.unitId));
    if (!ref || ref.aktif !== 1) {
      throw errors.conflict('Unit organisasi pada pengajuan sudah tidak aktif. Tolak pengajuan ini.');
    }
  }

  const status = ('statusKepegawaian' in values ? values.statusKepegawaian : row.cur_status_kepegawaian) as
    | StatusKepegawaian
    | null;
  const pangkat = ('pangkatKode' in values ? values.pangkatKode : row.cur_pangkat_kode) as string | null;
  if (pangkat !== null && status !== null) {
    const ref = pangkatRef(pangkat);
    if (ref && ref.jenis_asn !== asnFamily(status)) {
      throw errors.conflict(
        'Pangkat/golongan tidak lagi sesuai dengan status kepegawaian saat ini. Tolak pengajuan ini.',
      );
    }
  }
}

export async function approvePengajuan(
  env: Bindings,
  auth: AuthContext,
  rawId: string,
  body: unknown,
  meta: RequestMeta,
): Promise<Pengajuan> {
  const pid = parseId(rawId);
  const { catatan } = parseWith(reviewPengajuanRequestSchema, body);
  const { row, refs } = await loadForReview(env, auth, pid);

  // Whitelist: only known employment fields from the stored JSON are applied;
  // any other key (role, nip, …) is ignored even if it was injected into the row.
  const stored = JSON.parse(row.perubahan) as PerubahanMap;
  const values: Partial<Record<KepegawaianField, KepegawaianValue>> = {};
  for (const f of KEPEGAWAIAN_FIELDS) {
    const entry = stored[f];
    if (entry && typeof entry === 'object' && 'baru' in entry) values[f] = entry.baru;
  }
  const fieldNames = Object.keys(values);
  assertStillApplicable(row, values, refs);

  const db = env.DB;
  const adminId = auth.user.id;
  const nowIso = toIso(meta.nowMs);
  /*
   * Atomicity: D1 runs a batch as one transaction on one connection.
   *  (a) moves the request Menunggu → Disetujui only if still pending and the
   *      owner is not soft-deleted; a cancelled/processed request matches nothing.
   *  (b) applies the values only if (a) changed a row in this batch (`changes() > 0`)
   *      AND stamped THIS approval (status, now, admin), so a lost race or a replay
   *      — even within the same millisecond — can never apply values twice, log
   *      twice, or apply a cancelled request.
   *  (c) audits only if (b) changed the pegawai row.
   * Any constraint error in (b) rolls back (a) as well.
   */
  const [upd, , , sel] = await db.batch([
    reviewPengajuan(db, pid, 'Disetujui', adminId, catatan || null, nowIso),
    applyApprovedPerubahan(db, pid, row.pegawai_id, values, adminId, nowIso),
    auditStatement(
      db,
      {
        ts: nowIso,
        actor: actorOf(auth),
        action: 'PENGAJUAN_APPROVE',
        targetType: 'pengajuan',
        targetId: pid,
        description: `Pengajuan #${pid} pegawai ${row.pegawai_id} disetujui: ${fieldNames.join(', ')}`,
        result: 'SUCCESS',
        ip: meta.ip,
      },
      { onlyIfPreviousChanged: true },
    ),
    selectPengajuanById(db, pid),
  ]);
  if ((upd?.meta.changes ?? 0) !== 1) throw errors.conflict(MSG_ALREADY_PROCESSED);
  const updated = first<PengajuanWithReviewerRow>(sel);
  if (!updated) throw errors.notFound(MSG_NOT_FOUND);
  return rowToPengajuan(updated);
}

export async function rejectPengajuan(
  env: Bindings,
  auth: AuthContext,
  rawId: string,
  body: unknown,
  meta: RequestMeta,
): Promise<Pengajuan> {
  const pid = parseId(rawId);
  const { catatan } = parseWith(rejectPengajuanRequestSchema, body);
  const { row } = await loadForReview(env, auth, pid);

  const db = env.DB;
  const nowIso = toIso(meta.nowMs);
  const [upd, , sel] = await db.batch([
    reviewPengajuan(db, pid, 'Ditolak', auth.user.id, catatan, nowIso),
    auditStatement(
      db,
      {
        ts: nowIso,
        actor: actorOf(auth),
        action: 'PENGAJUAN_REJECT',
        targetType: 'pengajuan',
        targetId: pid,
        description: `Pengajuan #${pid} pegawai ${row.pegawai_id} ditolak`,
        result: 'SUCCESS',
        ip: meta.ip,
      },
      { onlyIfPreviousChanged: true },
    ),
    selectPengajuanById(db, pid),
  ]);
  if ((upd?.meta.changes ?? 0) !== 1) throw errors.conflict(MSG_ALREADY_PROCESSED);
  const updated = first<PengajuanWithReviewerRow>(sel);
  if (!updated) throw errors.notFound(MSG_NOT_FOUND);
  return rowToPengajuan(updated);
}
