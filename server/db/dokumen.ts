// SQL helpers for the document archive (Phase 4). Every mutation helper returns
// prepared statements so the service can run it in ONE db.batch() together with
// riwayat + audit rows (all-or-nothing, MIGRATION_PLAN §3.1 rule 10).
import type { StatusDokumen } from '../../shared/enums';

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

/** jenis_dokumen LEFT JOIN arsip_dokumen (any deleted state) for one pegawai. */
export interface DokumenListRow {
  jenis_id: string;
  jenis_nama: string;
  kategori: string;
  aktif: number;
  max_size_bytes: number;
  wajib: number;
  arsip_id: number | null;
  status: StatusDokumen | null;
  file_name: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  versi: number | null;
  catatan_admin: string | null;
  uploaded_at: string | null;
  verified_at: string | null;
  verified_by: number | null;
  verifier_nama: string | null;
  deleted_at: string | null;
  purge_after: string | null;
}

export interface DokumenVersiRow {
  arsip_id: number;
  versi: number;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  status: StatusDokumen;
  uploaded_at: string;
  replaced_at: string;
  reason: VersiReason;
  purge_after: string;
}

export type VersiReason = 'REUPLOAD' | 'DELETE';

/**
 * A version an OWNER may not roll back to: a verified file that was soft-deleted
 * (by an admin, since owners cannot delete verified files) and later replaced by an
 * upload. Rolling back to it would undo the admin's removal (same rule as restore).
 * SQL twin: OWNER_ROLLBACK_TARGET_SQL.
 */
export function isAdminOnlyVersi(v: { reason: VersiReason; status: StatusDokumen }): boolean {
  return v.reason === 'DELETE' && v.status === 'Terverifikasi';
}
/** SQL predicate (alias `x`) for versions an owner MAY roll back to. */
export const OWNER_ROLLBACK_TARGET_SQL = `NOT (x.reason = 'DELETE' AND x.status = 'Terverifikasi')`;

/** Full arsip_dokumen row (owner of a non-deleted pegawai). */
export interface ArsipRow {
  id: number;
  pegawai_id: number;
  jenis_dokumen_id: string;
  status: StatusDokumen;
  r2_key: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  versi: number;
  catatan_admin: string | null;
  uploaded_at: string;
  uploaded_by: number | null;
  verified_at: string | null;
  verified_by: number | null;
  deleted_at: string | null;
  purge_after: string | null;
}

export interface VersiFileRow {
  versi: number;
  r2_key: string;
  file_name: string;
  mime_type: string;
  status: StatusDokumen;
  reason: VersiReason;
  purge_after: string;
}

export interface RiwayatRow {
  id: number;
  versi: number;
  aksi: string;
  status: StatusDokumen | null;
  catatan: string | null;
  actor_id: number | null;
  actor_nama: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

/**
 * Document types with this pegawai's arsip state. Without `jenisId`: all ACTIVE
 * types plus inactive types that already have an archive (history must remain visible).
 * With `jenisId`: exactly that type, even if inactive (so a mutation on an
 * arsip of a since-deactivated type can still return its item; `aktif` tells).
 * `wajib` uses the pegawai's current status; inactive types never count as mandatory.
 */
export function selectDokumenRows(
  db: D1Database,
  pegawaiId: number,
  jenisId: string | null = null,
): D1PreparedStatement {
  return db
    .prepare(
      `SELECT j.id AS jenis_id, j.nama AS jenis_nama, j.kategori, j.aktif, j.max_size_bytes,
               (j.aktif = 1 AND EXISTS(SELECT 1 FROM jenis_dokumen_wajib w
                      WHERE w.jenis_dokumen_id = j.id
                         AND w.status_kepegawaian = (SELECT p.status_kepegawaian FROM pegawai p WHERE p.id = ?1))) AS wajib,
              a.id AS arsip_id, a.status, a.file_name, a.mime_type, a.size_bytes, a.versi, a.catatan_admin,
              a.uploaded_at, a.verified_at, a.verified_by, vp.nama AS verifier_nama, a.deleted_at, a.purge_after
         FROM jenis_dokumen j
         LEFT JOIN arsip_dokumen a ON a.jenis_dokumen_id = j.id AND a.pegawai_id = ?1
         LEFT JOIN pegawai vp ON vp.id = a.verified_by
         WHERE (?2 IS NULL AND (j.aktif = 1 OR a.id IS NOT NULL)) OR j.id = ?2
        ORDER BY j.urutan, j.nama, j.id`,
    )
    .bind(pegawaiId, jenisId);
}

/** Restorable versions of this pegawai's arsip rows, newest first per arsip. */
export function selectVersiRows(
  db: D1Database,
  pegawaiId: number,
  nowIso: string,
  jenisId: string | null = null,
): D1PreparedStatement {
  return db
    .prepare(
      `SELECT v.arsip_id, v.versi, v.file_name, v.mime_type, v.size_bytes, v.status, v.uploaded_at,
              v.replaced_at, v.reason, v.purge_after
         FROM arsip_dokumen_versi v
         JOIN arsip_dokumen a ON a.id = v.arsip_id
        WHERE a.pegawai_id = ?1 AND v.purge_after > ?2 AND (?3 IS NULL OR a.jenis_dokumen_id = ?3)
        ORDER BY v.arsip_id, v.versi DESC`,
    )
    .bind(pegawaiId, nowIso, jenisId);
}

// ---------------------------------------------------------------------------
// Single arsip
// ---------------------------------------------------------------------------

/** Arsip row by id, only when its pegawai is not deleted. */
export function selectArsipById(db: D1Database, arsipId: number): D1PreparedStatement {
  return db
    .prepare(
      `SELECT a.* FROM arsip_dokumen a
         JOIN pegawai p ON p.id = a.pegawai_id AND p.deleted_at IS NULL
        WHERE a.id = ?1`,
    )
    .bind(arsipId);
}

export function selectVersiFile(db: D1Database, arsipId: number, versi: number, nowIso: string): D1PreparedStatement {
  return db
    .prepare(
      `SELECT versi, r2_key, file_name, mime_type, status, reason, purge_after FROM arsip_dokumen_versi
        WHERE arsip_id = ?1 AND versi = ?2 AND purge_after > ?3`,
    )
    .bind(arsipId, versi, nowIso);
}

/**
 * History of one document slot. Rows must match the arsip's id AND its
 * (pegawai_id, jenis_dokumen_id) (migration 0004): arsip ids are not AUTOINCREMENT,
 * so a purged id can be reused and must never expose another slot's history.
 * Rows of purged slots (NULL pegawai_id) therefore never match.
 */
export function selectRiwayat(db: D1Database, arsipId: number, limit = 50): D1PreparedStatement {
  return db
    .prepare(
      `SELECT r.id, r.versi, r.aksi, r.status, r.catatan, r.actor_id, p.nama AS actor_nama, r.created_at
         FROM arsip_dokumen_riwayat r
         JOIN arsip_dokumen a
           ON a.id = r.arsip_id AND a.pegawai_id = r.pegawai_id AND a.jenis_dokumen_id = r.jenis_dokumen_id
         LEFT JOIN pegawai p ON p.id = r.actor_id
        WHERE r.arsip_id = ?1
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT ?2`,
    )
    .bind(arsipId, limit);
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------
//
// PURGE CRON REQUIREMENT (versions and soft-deleted arsip, owner decision #4):
// the request path never deletes R2 objects of replaced/deleted files; the cron does.
// It must
//   1. delete rows with SQL-guarded conditions only, re-checked at delete time, e.g.
//      `DELETE FROM arsip_dokumen_versi WHERE id = ? AND purge_after <= ?now RETURNING r2_key`
//      and `DELETE FROM arsip_dokumen WHERE id = ? AND deleted_at IS NOT NULL
//      AND purge_after <= ?now RETURNING r2_key` (a concurrent restore, rollback or
//      upload-over-deleted makes the guard fail, so nothing is removed);
//   2. delete R2 objects ONLY for keys taken from rows it actually removed (RETURNING /
//      meta.changes), and only if `r2KeyReferenced(key)` finds no remaining row
//      (a rollback may have moved the same key back into arsip_dokumen);
//   3. never delete by listing an R2 prefix and diffing.

export interface NewFile {
  r2Key: string;
  fileName: string;
  mime: string;
  size: number;
  sha256: string;
}

export function insertArsip(
  db: D1Database,
  pegawaiId: number,
  jenisId: string,
  f: NewFile,
  actorId: number,
  nowIso: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO arsip_dokumen
         (pegawai_id, jenis_dokumen_id, status, r2_key, file_name, mime_type, size_bytes, sha256, versi, uploaded_at, uploaded_by)
       VALUES (?1, ?2, 'Menunggu', ?3, ?4, ?5, ?6, ?7, 1, ?8, ?9)`,
    )
    .bind(pegawaiId, jenisId, f.r2Key, f.fileName, f.mime, f.size, f.sha256, nowIso, actorId);
}

/**
 * Copy the CURRENT file of an active arsip into arsip_dokumen_versi (purge after
 * `purgeIso`). Guarded by the expected versi (compare-and-set) and `extraWhere`.
 * Version rows only ever hold numbers lower than the arsip's current versi (it only
 * increments), so UNIQUE(arsip_id, versi) cannot collide here.
 */
export function copyCurrentToVersi(
  db: D1Database,
  arsipId: number,
  expectedVersi: number,
  nowIso: string,
  purgeIso: string,
  extraWhere: string,
  ...extraBinds: unknown[]
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO arsip_dokumen_versi
         (arsip_id, versi, r2_key, file_name, mime_type, size_bytes, sha256, status, catatan_admin,
          uploaded_at, uploaded_by, verified_at, verified_by, replaced_at, reason, purge_after)
       SELECT id, versi, r2_key, file_name, mime_type, size_bytes, sha256, status, catatan_admin,
              uploaded_at, uploaded_by, verified_at, verified_by, ?3, 'REUPLOAD', ?4
         FROM arsip_dokumen
        WHERE id = ?1 AND versi = ?2 AND deleted_at IS NULL ${extraWhere}`,
    )
    .bind(arsipId, expectedVersi, nowIso, purgeIso, ...extraBinds);
}

/**
 * Copy the file of a SOFT-DELETED arsip into arsip_dokumen_versi (reason 'DELETE'),
 * keeping the arsip's own purge_after when still in the future, else `nowIso`
 * (already expired: hidden immediately, the cron purges it). Guarded by the expected
 * versi; same UNIQUE argument as copyCurrentToVersi.
 */
export function copyDeletedToVersi(
  db: D1Database,
  arsipId: number,
  expectedVersi: number,
  nowIso: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO arsip_dokumen_versi
         (arsip_id, versi, r2_key, file_name, mime_type, size_bytes, sha256, status, catatan_admin,
          uploaded_at, uploaded_by, verified_at, verified_by, replaced_at, reason, purge_after)
       SELECT id, versi, r2_key, file_name, mime_type, size_bytes, sha256, status, catatan_admin,
              uploaded_at, uploaded_by, verified_at, verified_by, ?3, 'DELETE',
              CASE WHEN purge_after > ?3 THEN purge_after ELSE ?3 END
         FROM arsip_dokumen
        WHERE id = ?1 AND versi = ?2 AND deleted_at IS NOT NULL`,
    )
    .bind(arsipId, expectedVersi, nowIso);
}

/**
 * Replace the current file; runs only if the previous statement (version copy)
 * inserted. Also clears a soft delete (upload over a deleted arsip, contract M1).
 */
export function updateArsipNewFile(
  db: D1Database,
  arsipId: number,
  expectedVersi: number,
  f: NewFile,
  actorId: number,
  nowIso: string,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE arsip_dokumen
          SET r2_key = ?3, file_name = ?4, mime_type = ?5, size_bytes = ?6, sha256 = ?7,
              versi = versi + 1, status = 'Menunggu', catatan_admin = NULL,
              uploaded_at = ?8, uploaded_by = ?9, verified_at = NULL, verified_by = NULL,
              deleted_at = NULL, purge_after = NULL
        WHERE id = ?1 AND versi = ?2 AND changes() > 0`,
    )
    .bind(arsipId, expectedVersi, f.r2Key, f.fileName, f.mime, f.size, f.sha256, nowIso, actorId);
}

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

/**
 * Make version `targetVersi` the current file again, restoring its status /
 * catatan / verified_*. Runs only if the previous statement changed a row.
 * `uploaded_by` is restored from the version row (migration 0003; NULL for older rows).
 */
export function updateArsipFromVersi(
  db: D1Database,
  arsipId: number,
  expectedVersi: number,
  targetVersi: number,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE arsip_dokumen
          SET (r2_key, file_name, mime_type, size_bytes, sha256, status, catatan_admin, uploaded_at,
               uploaded_by, verified_at, verified_by) =
              (SELECT r2_key, file_name, mime_type, size_bytes, sha256, status, catatan_admin, uploaded_at,
                      uploaded_by, verified_at, verified_by
                 FROM arsip_dokumen_versi WHERE arsip_id = ?1 AND versi = ?3),
              versi = versi + 1
        WHERE id = ?1 AND versi = ?2 AND changes() > 0`,
    )
    .bind(arsipId, expectedVersi, targetVersi);
}

export function deleteVersiRow(db: D1Database, arsipId: number, versi: number): D1PreparedStatement {
  return db
    .prepare(`DELETE FROM arsip_dokumen_versi WHERE arsip_id = ?1 AND versi = ?2 AND changes() > 0`)
    .bind(arsipId, versi);
}

// ---------------------------------------------------------------------------
// Soft delete / restore
// ---------------------------------------------------------------------------

export function softDeleteArsip(
  db: D1Database,
  arsipId: number,
  nowIso: string,
  purgeIso: string,
  allowVerified: boolean,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE arsip_dokumen SET deleted_at = ?2, purge_after = ?3
        WHERE id = ?1 AND deleted_at IS NULL AND (?4 = 1 OR status <> 'Terverifikasi')`,
    )
    .bind(arsipId, nowIso, purgeIso, allowVerified ? 1 : 0);
}

/** Undo a soft delete; owners (allowVerified = false) cannot restore a Terverifikasi row. */
export function restoreArsip(
  db: D1Database,
  arsipId: number,
  nowIso: string,
  allowVerified: boolean,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE arsip_dokumen SET deleted_at = NULL, purge_after = NULL
        WHERE id = ?1 AND deleted_at IS NOT NULL AND purge_after > ?2
          AND (?3 = 1 OR status <> 'Terverifikasi')`,
    )
    .bind(arsipId, nowIso, allowVerified ? 1 : 0);
}

/** One row when any arsip or version row still references this R2 key. */
export function r2KeyReferenced(db: D1Database, key: string): D1PreparedStatement {
  return db
    .prepare(
      `SELECT 1 AS ok FROM arsip_dokumen WHERE r2_key = ?1
       UNION ALL
       SELECT 1 AS ok FROM arsip_dokumen_versi WHERE r2_key = ?1
       LIMIT 1`,
    )
    .bind(key);
}

// ---------------------------------------------------------------------------
// Riwayat
// ---------------------------------------------------------------------------

/**
 * Riwayat row describing the arsip's state AFTER the previous statement; inserted
 * only if that statement changed a row. `where` locates the arsip (by id, or by
 * pegawai + jenis for a first upload whose id is not known yet).
 */
export function riwayatAfterChange(
  db: D1Database,
  aksi: string,
  catatan: string | null,
  actorId: number,
  nowIso: string,
  where: { arsipId: number } | { pegawaiId: number; jenisId: string },
): D1PreparedStatement {
  const cond = 'arsipId' in where ? 'id = ?5' : 'pegawai_id = ?5 AND jenis_dokumen_id = ?6';
  const binds = 'arsipId' in where ? [where.arsipId] : [where.pegawaiId, where.jenisId];
  return db
    .prepare(
      `INSERT INTO arsip_dokumen_riwayat
         (arsip_id, pegawai_id, jenis_dokumen_id, versi, aksi, status, catatan, actor_id, created_at)
       SELECT id, pegawai_id, jenis_dokumen_id, versi, ?1, status, ?2, ?3, ?4
         FROM arsip_dokumen WHERE ${cond} AND changes() > 0`,
    )
    .bind(aksi, catatan, actorId, nowIso, ...binds);
}
