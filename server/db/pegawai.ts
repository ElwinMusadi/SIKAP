// SQL helpers for the admin Master Data Pegawai (Phase 6, contract: shared/pegawai.ts).
// Every statement is parameterised; dynamic SQL is assembled ONLY from fixed fragments
// (whitelisted sort map, fixed column maps), never from user input.
import type { Role, StatusAkun, StatusKepegawaian } from '../../shared/enums';
import type { Kelengkapan, PegawaiListItem, PegawaiSort } from '../../shared/pegawai';
import { photoUrl } from '../lib/photo-url';

// ---------------------------------------------------------------------------
// Mandatory-document statistics + completeness label
// ---------------------------------------------------------------------------

/**
 * Completeness label from the stats columns `wajib_total`, `wajib_verified`, `wajib_ditolak`
 * (legacy parity, see KELENGKAPAN in shared/pegawai.ts). `alias` is the row alias holding
 * those columns (e.g. `s`), or '' for unqualified columns.
 */
export function kelengkapanSql(alias = ''): string {
  const a = alias ? `${alias}.` : '';
  return `CASE WHEN ${a}wajib_ditolak > 0 THEN 'Perlu Revisi'
               WHEN ${a}wajib_total > 0 AND ${a}wajib_verified = ${a}wajib_total THEN 'Lengkap'
               ELSE 'Belum Lengkap' END`;
}
/** Unqualified form of {@link kelengkapanSql}. */
export const KELENGKAPAN_SQL = kelengkapanSql();

/**
 * CTE text (without the leading `WITH`) defining:
 *   wajib(st, jid)  — active mandatory document types per status kepegawaian;
 *   stats(pid, wajib_total, wajib_verified, wajib_ditolak, menunggu, kelengkapan)
 *     — per pegawai `p` matching `scopeWhere` (a fixed SQL fragment over alias `p`,
 *       which may reference bound parameters).
 * At most one active arsip exists per (pegawai, jenis); DISTINCT keeps counts exact anyway.
 */
export function docStatsCte(scopeWhere: string): string {
  return `wajib AS (
      SELECT w.status_kepegawaian AS st, w.jenis_dokumen_id AS jid
        FROM jenis_dokumen_wajib w
        JOIN jenis_dokumen j ON j.id = w.jenis_dokumen_id AND j.aktif = 1
    ),
    raw_stats AS (
      SELECT p.id AS pid,
             COUNT(DISTINCT w.jid) AS wajib_total,
             COUNT(DISTINCT CASE WHEN a.status = 'Terverifikasi' THEN w.jid END) AS wajib_verified,
             COUNT(DISTINCT CASE WHEN a.status = 'Ditolak' THEN w.jid END) AS wajib_ditolak,
             (SELECT COUNT(*) FROM arsip_dokumen m
               WHERE m.pegawai_id = p.id AND m.status = 'Menunggu' AND m.deleted_at IS NULL) AS menunggu
        FROM pegawai p
        LEFT JOIN wajib w ON w.st = p.status_kepegawaian
        LEFT JOIN arsip_dokumen a
          ON a.pegawai_id = p.id AND a.jenis_dokumen_id = w.jid AND a.deleted_at IS NULL
       WHERE ${scopeWhere}
       GROUP BY p.id
    ),
    stats AS (
      SELECT raw_stats.*, ${kelengkapanSql('raw_stats')} AS kelengkapan FROM raw_stats
    )`;
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export interface PegawaiListFilter {
  /** 'active': deleted_at IS NULL; 'deleted': soft-deleted within retention; 'any': no filter. */
  scope: 'active' | 'deleted' | 'any';
  id?: number;
  q?: string;
  statusKepegawaian?: StatusKepegawaian;
  statusAkun?: StatusAkun;
  kelengkapan?: Kelengkapan;
  belumUnggah?: string;
  passwordDefault?: boolean;
}

export interface PegawaiListRow {
  id: number;
  nip: string;
  nama: string;
  role: Role;
  status_akun: StatusAkun;
  status_kepegawaian: StatusKepegawaian | null;
  pangkat_kode: string | null;
  jabatan: string | null;
  unit_id: number | null;
  foto_r2_key: string | null;
  updated_at: string;
  deleted_at: string | null;
  purge_after: string | null;
  deleted_by: number | null;
  deleted_by_nama: string | null;
  is_default_password: number | null;
  terkunci: number;
  wajib_total: number;
  wajib_verified: number;
  menunggu: number;
  kelengkapan: Kelengkapan;
}

const SORT_SQL: Record<PegawaiSort, (dir: 'ASC' | 'DESC') => string> = {
  nama: (d) => `l.nama COLLATE NOCASE ${d}, l.id ${d}`,
  nip: (d) => `l.nip ${d}, l.id ${d}`,
  // Perlu Revisi < Belum Lengkap < Lengkap, then progress, then name.
  kelengkapan: (d) =>
    `CASE l.kelengkapan WHEN 'Perlu Revisi' THEN 0 WHEN 'Belum Lengkap' THEN 1 ELSE 2 END ${d},
     CASE WHEN l.wajib_total > 0 THEN CAST(l.wajib_verified AS REAL) / l.wajib_total ELSE 0 END ${d},
     l.nama COLLATE NOCASE ASC, l.id ASC`,
  updatedAt: (d) => `l.updated_at ${d}, l.id ${d}`,
};

/** `%` and `_` (and the escape char) are literal in `q`. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

interface BuiltList {
  /** `WITH … , list AS (…)` — select from `list l`. */
  sql: string;
  params: unknown[];
}

function buildList(f: PegawaiListFilter, nowIso: string): BuiltList {
  const params: unknown[] = [];
  const p = (v: unknown): string => {
    params.push(v);
    return `?${params.length}`;
  };
  const now = p(nowIso);

  const scope: string[] = [];
  if (f.scope === 'active') scope.push('p.deleted_at IS NULL');
  else if (f.scope === 'deleted') scope.push(`p.deleted_at IS NOT NULL AND p.purge_after > ${now}`);
  if (f.id !== undefined) scope.push(`p.id = ${p(f.id)}`);
  if (f.q) {
    const pat = p(likePattern(f.q));
    scope.push(`(p.nama LIKE ${pat} ESCAPE '\\' OR p.nip LIKE ${pat} ESCAPE '\\')`);
  }
  if (f.statusKepegawaian) scope.push(`p.status_kepegawaian = ${p(f.statusKepegawaian)}`);
  if (f.statusAkun) scope.push(`p.status_akun = ${p(f.statusAkun)}`);
  if (f.passwordDefault) {
    scope.push('EXISTS (SELECT 1 FROM akun ka WHERE ka.pegawai_id = p.id AND ka.is_default_password = 1)');
  }
  if (f.belumUnggah) {
    const jid = p(f.belumUnggah);
    scope.push(`EXISTS (SELECT 1 FROM jenis_dokumen_wajib bw
                          JOIN jenis_dokumen bj ON bj.id = bw.jenis_dokumen_id AND bj.aktif = 1
                         WHERE bw.jenis_dokumen_id = ${jid} AND bw.status_kepegawaian = p.status_kepegawaian)
                AND NOT EXISTS (SELECT 1 FROM arsip_dokumen ba
                                 WHERE ba.pegawai_id = p.id AND ba.jenis_dokumen_id = ${jid}
                                   AND ba.deleted_at IS NULL)`);
  }
  const outer = f.kelengkapan ? `WHERE s.kelengkapan = ${p(f.kelengkapan)}` : '';

  const sql = `WITH ${docStatsCte(scope.length ? scope.join(' AND ') : '1 = 1')},
    list AS (
      SELECT p.id, p.nip, p.nama, p.role, p.status_akun, p.status_kepegawaian, p.pangkat_kode, p.jabatan,
             p.unit_id, p.foto_r2_key, p.updated_at, p.deleted_at, p.purge_after, p.deleted_by,
             d.nama AS deleted_by_nama,
             k.is_default_password,
             CASE WHEN k.locked_until IS NOT NULL AND k.locked_until > ${now} THEN 1 ELSE 0 END AS terkunci,
             s.wajib_total, s.wajib_verified, s.menunggu, s.kelengkapan
        FROM stats s
        JOIN pegawai p ON p.id = s.pid
        LEFT JOIN akun k ON k.pegawai_id = p.id
        LEFT JOIN pegawai d ON d.id = p.deleted_by
       ${outer}
    )`;
  return { sql, params };
}

/** Items page + total (same WHERE) + header summary: run the three in ONE db.batch. */
export function listStatements(
  db: D1Database,
  f: PegawaiListFilter,
  sort: PegawaiSort,
  dir: 'asc' | 'desc',
  limit: number,
  offset: number,
  nowIso: string,
): [D1PreparedStatement, D1PreparedStatement, D1PreparedStatement] {
  const { sql, params } = buildList(f, nowIso);
  const order = SORT_SQL[sort](dir === 'desc' ? 'DESC' : 'ASC');
  const n = params.length;
  const items = db
    .prepare(`${sql} SELECT * FROM list l ORDER BY ${order} LIMIT ?${n + 1} OFFSET ?${n + 2}`)
    .bind(...params, limit, offset);
  const total = db.prepare(`${sql} SELECT COUNT(*) AS n FROM list l`).bind(...params);
  return [items, total, summaryStatement(db, nowIso)];
}

export interface PegawaiSummaryRow {
  total: number;
  aktif: number;
  nonaktif: number;
  password_default: number;
  terhapus: number;
}

/** Header totals ignoring filters; soft-deleted rows only count in `terhapus` (within retention). */
export function summaryStatement(db: D1Database, nowIso: string): D1PreparedStatement {
  return db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN p.deleted_at IS NULL THEN 1 ELSE 0 END), 0) AS total,
         COALESCE(SUM(CASE WHEN p.deleted_at IS NULL AND p.status_akun = 'Aktif' THEN 1 ELSE 0 END), 0) AS aktif,
         COALESCE(SUM(CASE WHEN p.deleted_at IS NULL AND p.status_akun = 'Nonaktif' THEN 1 ELSE 0 END), 0) AS nonaktif,
         COALESCE(SUM(CASE WHEN p.deleted_at IS NULL AND k.is_default_password = 1 THEN 1 ELSE 0 END), 0)
           AS password_default,
         COALESCE(SUM(CASE WHEN p.deleted_at IS NOT NULL AND p.purge_after > ?1 THEN 1 ELSE 0 END), 0) AS terhapus
       FROM pegawai p LEFT JOIN akun k ON k.pegawai_id = p.id`,
    )
    .bind(nowIso);
}

export function rowToListItem(r: PegawaiListRow): PegawaiListItem {
  const wajibTotal = r.wajib_total ?? 0;
  const wajibTerverifikasi = r.wajib_verified ?? 0;
  return {
    id: r.id,
    nip: r.nip,
    nama: r.nama,
    role: r.role,
    statusAkun: r.status_akun,
    statusKepegawaian: r.status_kepegawaian,
    pangkatKode: r.pangkat_kode,
    jabatan: r.jabatan,
    unitId: r.unit_id,
    fotoUrl: r.foto_r2_key ? photoUrl(r.id, r.foto_r2_key) : null,
    isDefaultPassword: r.is_default_password === 1,
    terkunci: r.terkunci === 1,
    dokumen: {
      wajibTotal,
      wajibTerverifikasi,
      persen: wajibTotal ? Math.round((wajibTerverifikasi / wajibTotal) * 100) : 0,
      kelengkapan: r.kelengkapan,
      menunggu: r.menunggu ?? 0,
    },
    updatedAt: r.updated_at,
    deleted:
      r.deleted_at && r.purge_after
        ? {
            deletedAt: r.deleted_at,
            purgeAfter: r.purge_after,
            deletedBy: r.deleted_by !== null && r.deleted_by_nama !== null ? { id: r.deleted_by, nama: r.deleted_by_nama } : null,
          }
        : null,
  };
}

/**
 * The list query restricted to one id (deleted or not; callers decide), batchable.
 * Map the first result row with {@link rowToListItem}.
 */
export function selectListItemById(db: D1Database, id: number, nowIso: string): D1PreparedStatement {
  const { sql, params } = buildList({ scope: 'any', id }, nowIso);
  return db.prepare(`${sql} SELECT * FROM list l`).bind(...params);
}

/** One list item by id (including soft-deleted rows), or null. */
export async function listItemById(db: D1Database, id: number, nowIso: string): Promise<PegawaiListItem | null> {
  const row = await selectListItemById(db, id, nowIso).first<PegawaiListRow>();
  return row ? rowToListItem(row) : null;
}

// ---------------------------------------------------------------------------
// Account / sessions / admins
// ---------------------------------------------------------------------------

export interface AkunRow {
  is_default_password: number;
  failed_attempts: number;
  locked_until: string | null;
  last_login_at: string | null;
  password_changed_at: string | null;
}

export function selectAkun(db: D1Database, pegawaiId: number): D1PreparedStatement {
  return db
    .prepare(
      `SELECT is_default_password, failed_attempts, locked_until, last_login_at, password_changed_at
         FROM akun WHERE pegawai_id = ?1`,
    )
    .bind(pegawaiId);
}

/** Non-expired sessions of a pegawai: `{ n }`. */
export function countActiveSessions(db: D1Database, pegawaiId: number, nowIso: string): D1PreparedStatement {
  return db.prepare(`SELECT COUNT(*) AS n FROM sesi WHERE pegawai_id = ?1 AND expires_at > ?2`).bind(pegawaiId, nowIso);
}

/** Revoke every session of a pegawai (`meta.changes` = sessions revoked). */
export function revokeSessions(db: D1Database, pegawaiId: number): D1PreparedStatement {
  return db.prepare(`DELETE FROM sesi WHERE pegawai_id = ?1`).bind(pegawaiId);
}

/** Active (status Aktif, not deleted) admins other than `id`: `{ n }`. Batchable. */
export function countActiveAdminsExcludingStmt(db: D1Database, id: number): D1PreparedStatement {
  return db
    .prepare(
      `SELECT COUNT(*) AS n FROM pegawai
        WHERE role = 'Admin' AND status_akun = 'Aktif' AND deleted_at IS NULL AND id <> ?1`,
    )
    .bind(id);
}

export async function countActiveAdminsExcluding(db: D1Database, id: number): Promise<number> {
  const row = await countActiveAdminsExcludingStmt(db, id).first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * SQL guard (alias-free, over the `pegawai` row being updated, `?idParam` = its id): true when
 * at least one OTHER active admin exists. Use in UPDATE … WHERE to make the last-admin rule atomic.
 */
export function otherActiveAdminExistsSql(idParam: string): string {
  return `EXISTS (SELECT 1 FROM pegawai oa
                   WHERE oa.role = 'Admin' AND oa.status_akun = 'Aktif' AND oa.deleted_at IS NULL
                     AND oa.id <> ${idParam})`;
}

/** Owner of a NIP among ALL rows (including soft-deleted). */
export function selectNipOwner(db: D1Database, nip: string): D1PreparedStatement {
  return db.prepare(`SELECT id, deleted_at, purge_after FROM pegawai WHERE nip = ?1`).bind(nip);
}

// ---------------------------------------------------------------------------
// Account actions (Part B)
// ---------------------------------------------------------------------------

/**
 * Set status_akun. Matches nothing when the row is deleted/unknown, already in that state, or
 * (deactivating an active Admin) no other active admin exists — the last-admin rule is atomic.
 */
export function updateStatusAkun(db: D1Database, id: number, statusAkun: StatusAkun, nowIso: string): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE pegawai SET status_akun = ?2, updated_at = ?3
        WHERE id = ?1 AND deleted_at IS NULL AND status_akun <> ?2
          AND (?2 = 'Aktif' OR role <> 'Admin' OR status_akun <> 'Aktif' OR ${otherActiveAdminExistsSql('?1')})`,
    )
    .bind(id, statusAkun, nowIso);
}

/** Revoke sessions only while the pegawai is (now) Nonaktif — post-condition guard. */
export function revokeSessionsIfNonaktif(db: D1Database, id: number): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM sesi WHERE pegawai_id = ?1
          AND EXISTS (SELECT 1 FROM pegawai WHERE id = ?1 AND status_akun = 'Nonaktif')`,
    )
    .bind(id);
}

/** Non-deleted pegawai NIP (needed to derive the default password). */
export function selectActiveNip(db: D1Database, id: number): D1PreparedStatement {
  return db.prepare(`SELECT nip FROM pegawai WHERE id = ?1 AND deleted_at IS NULL`).bind(id);
}

/**
 * Reset to the default password (upsert: also repairs a missing akun row). Matches nothing when
 * the pegawai is deleted/unknown or its NIP is not `nip` (the hash was derived from it).
 */
export function resetPasswordStmt(
  db: D1Database,
  id: number,
  nip: string,
  passwordHash: string,
  nowIso: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO akun (pegawai_id, password_hash, is_default_password, failed_attempts, locked_until, password_changed_at)
       SELECT id, ?3, 1, 0, NULL, ?4 FROM pegawai WHERE id = ?1 AND nip = ?2 AND deleted_at IS NULL
       ON CONFLICT (pegawai_id) DO UPDATE SET
         password_hash = excluded.password_hash, is_default_password = 1, failed_attempts = 0,
         locked_until = NULL, password_changed_at = excluded.password_changed_at`,
    )
    .bind(id, nip, passwordHash, nowIso);
}

/** Revoke sessions only if THIS reset applied (post-condition on the stamped row). */
export function revokeSessionsAfterReset(db: D1Database, id: number, passwordHash: string): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM sesi WHERE pegawai_id = ?1
          AND EXISTS (SELECT 1 FROM akun WHERE pegawai_id = ?1 AND password_hash = ?2)`,
    )
    .bind(id, passwordHash);
}

/** Clear the lockout; matches nothing when there is nothing to clear (no audit noise). */
export function unlockAkun(db: D1Database, id: number): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE akun SET failed_attempts = 0, locked_until = NULL
        WHERE pegawai_id = ?1 AND (failed_attempts > 0 OR locked_until IS NOT NULL)
          AND EXISTS (SELECT 1 FROM pegawai WHERE id = ?1 AND deleted_at IS NULL)`,
    )
    .bind(id);
}

// ---------------------------------------------------------------------------
// Soft delete / restore (Part B, owner decision #5)
// ---------------------------------------------------------------------------

/** Soft delete; atomic last-admin guard. Matches nothing when deleted/unknown or last admin. */
export function softDeletePegawai(
  db: D1Database,
  id: number,
  adminId: number,
  nowIso: string,
  purgeAfterIso: string,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE pegawai SET deleted_at = ?2, deleted_by = ?3, purge_after = ?4, updated_at = ?2
        WHERE id = ?1 AND deleted_at IS NULL
          AND (role <> 'Admin' OR status_akun <> 'Aktif' OR ${otherActiveAdminExistsSql('?1')})`,
    )
    .bind(id, nowIso, adminId, purgeAfterIso);
}

/** Post-condition: only when THIS delete applied (deleted_at stamped with `nowIso`). */
export function revokeSessionsAfterDelete(db: D1Database, id: number, nowIso: string): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM sesi WHERE pegawai_id = ?1
          AND EXISTS (SELECT 1 FROM pegawai WHERE id = ?1 AND deleted_at = ?2)`,
    )
    .bind(id, nowIso);
}

export function cancelPendingAfterDelete(db: D1Database, id: number, nowIso: string): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE pengajuan_perubahan SET status = 'Dibatalkan', reviewed_at = ?2
        WHERE pegawai_id = ?1 AND status = 'Menunggu'
          AND EXISTS (SELECT 1 FROM pegawai WHERE id = ?1 AND deleted_at = ?2)`,
    )
    .bind(id, nowIso);
}

/** Soft-deleted pegawai still within retention: `{ id }`. */
export function selectRestorable(db: D1Database, id: number, nowIso: string): D1PreparedStatement {
  return db
    .prepare(`SELECT id FROM pegawai WHERE id = ?1 AND deleted_at IS NOT NULL AND purge_after > ?2`)
    .bind(id, nowIso);
}

const NIK_TAKEN_SQL = (idParam: string) => `EXISTS (
    SELECT 1 FROM pegawai me JOIN pegawai o ON o.nik = me.nik AND o.id <> me.id AND o.deleted_at IS NULL
     WHERE me.id = ${idParam})`;

/**
 * One row when a non-deleted employee holds this pegawai's NIK. Defensive: the UNIQUE
 * constraint on nik also covers soft-deleted rows, so this only fires if that ever changes.
 */
export function restoreNikConflict(db: D1Database, id: number): D1PreparedStatement {
  return db.prepare(`SELECT 1 AS ok WHERE ${NIK_TAKEN_SQL('?1')}`).bind(id);
}

export function restorePegawai(db: D1Database, id: number, nowIso: string): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE pegawai SET deleted_at = NULL, deleted_by = NULL, purge_after = NULL, updated_at = ?2
        WHERE id = ?1 AND deleted_at IS NOT NULL AND purge_after > ?2 AND NOT ${NIK_TAKEN_SQL('?1')}`,
    )
    .bind(id, nowIso);
}

// ---------------------------------------------------------------------------
// Admin dashboard (Part B)
// ---------------------------------------------------------------------------

export interface DashboardPegawaiRow {
  total: number;
  aktif: number;
  nonaktif: number;
  pns: number;
  cpns: number;
  pppk: number;
  belum_diisi: number;
  password_default: number;
}

export function dashboardPegawaiStmt(db: D1Database): D1PreparedStatement {
  return db.prepare(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(p.status_akun = 'Aktif'), 0) AS aktif,
            COALESCE(SUM(p.status_akun = 'Nonaktif'), 0) AS nonaktif,
            COALESCE(SUM(p.status_kepegawaian = 'PNS'), 0) AS pns,
            COALESCE(SUM(p.status_kepegawaian = 'CPNS'), 0) AS cpns,
            COALESCE(SUM(p.status_kepegawaian = 'PPPK'), 0) AS pppk,
            COALESCE(SUM(p.status_kepegawaian IS NULL), 0) AS belum_diisi,
            COALESCE(SUM(k.is_default_password = 1), 0) AS password_default
       FROM pegawai p LEFT JOIN akun k ON k.pegawai_id = p.id
      WHERE p.deleted_at IS NULL`,
  );
}

export interface DashboardDokumenRow {
  wajib: number;
  verified: number;
  lengkap: number;
  belum_lengkap: number;
  perlu_revisi: number;
  menunggu: number;
  pengajuan_menunggu: number;
}

/** Completeness over ACTIVE non-deleted employees + global pending counts. */
export function dashboardDokumenStmt(db: D1Database): D1PreparedStatement {
  return db.prepare(
    `WITH ${docStatsCte(`p.deleted_at IS NULL AND p.status_akun = 'Aktif'`)}
     SELECT COALESCE(SUM(s.wajib_total), 0) AS wajib,
            COALESCE(SUM(s.wajib_verified), 0) AS verified,
            COALESCE(SUM(s.kelengkapan = 'Lengkap'), 0) AS lengkap,
            COALESCE(SUM(s.kelengkapan = 'Belum Lengkap'), 0) AS belum_lengkap,
            COALESCE(SUM(s.kelengkapan = 'Perlu Revisi'), 0) AS perlu_revisi,
            (SELECT COUNT(*) FROM arsip_dokumen a JOIN pegawai pa ON pa.id = a.pegawai_id AND pa.deleted_at IS NULL
              WHERE a.status = 'Menunggu' AND a.deleted_at IS NULL) AS menunggu,
            (SELECT COUNT(*) FROM pengajuan_perubahan q JOIN pegawai pq ON pq.id = q.pegawai_id AND pq.deleted_at IS NULL
              WHERE q.status = 'Menunggu') AS pengajuan_menunggu
       FROM stats s`,
  );
}

export interface AktivitasRow {
  id: number;
  ts: string;
  actor_nama: string | null;
  action: string;
  description: string | null;
  result: string;
}

/** Latest audit entries; idx_log_ts (ts DESC) serves the ORDER BY with LIMIT. */
export function latestAktivitasStmt(db: D1Database, limit: number): D1PreparedStatement {
  return db
    .prepare(
      `SELECT id, ts, actor_nama, action, description, result
         FROM log_aktivitas ORDER BY ts DESC, id DESC LIMIT ?1`,
    )
    .bind(limit);
}
