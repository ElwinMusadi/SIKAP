// SQL helpers for the admin verification queue + decisions (Phase 5).
//
// Index note: the queue filter `status = 'Menunggu' AND deleted_at IS NULL ORDER BY
// uploaded_at, id` is served by idx_arsip_status(status, uploaded_at): SQLite indexes
// carry the rowid (= id) as their last column, so the index order is exactly
// (uploaded_at, id) within status 'Menunggu' and the keyset predicate is a range scan.
// deleted_at is checked per row; pending soft-deleted rows are rare, so no new index.
import type { StatusDokumen, StatusKepegawaian } from '../../shared/enums';

export const QUEUE_PAGE_SIZE = 25;

export interface QueueRow {
  arsip_id: number;
  versi: number;
  jenis_id: string;
  jenis_nama: string;
  kategori: string;
  wajib: number;
  pegawai_id: number;
  nip: string;
  nama: string;
  status_kepegawaian: StatusKepegawaian | null;
  jabatan: string | null;
  unit_nama: string | null;
  foto_r2_key: string | null;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  uploaded_at: string;
  catatan_sebelumnya: string | null;
}

/** Pending items, oldest first, keyset after (uploadedAt, id). Fetches `limit` rows. */
export function selectQueue(
  db: D1Database,
  jenisId: string | null,
  cursor: { uploadedAt: string; id: number } | null,
  limit: number,
): D1PreparedStatement {
  return db
    .prepare(
      `SELECT a.id AS arsip_id, a.versi, j.id AS jenis_id, j.nama AS jenis_nama, j.kategori,
              EXISTS(SELECT 1 FROM jenis_dokumen_wajib w
                      WHERE w.jenis_dokumen_id = a.jenis_dokumen_id
                        AND w.status_kepegawaian = p.status_kepegawaian) AS wajib,
              p.id AS pegawai_id, p.nip, p.nama, p.status_kepegawaian, p.jabatan, u.nama AS unit_nama,
              p.foto_r2_key, a.file_name, a.mime_type, a.size_bytes, a.uploaded_at,
              CASE WHEN a.versi > 1 THEN (
                SELECT CASE WHEN r.aksi = 'REJECT' THEN r.catatan END
                  FROM arsip_dokumen_riwayat r
                 WHERE r.arsip_id = a.id AND r.pegawai_id = a.pegawai_id
                   AND r.jenis_dokumen_id = a.jenis_dokumen_id AND r.aksi IN ('APPROVE', 'REJECT')
                 ORDER BY r.created_at DESC, r.id DESC LIMIT 1)
              END AS catatan_sebelumnya
         FROM arsip_dokumen a
         JOIN pegawai p ON p.id = a.pegawai_id AND p.deleted_at IS NULL
         JOIN jenis_dokumen j ON j.id = a.jenis_dokumen_id
         LEFT JOIN ref_unit_organisasi u ON u.id = p.unit_id
        WHERE a.status = 'Menunggu' AND a.deleted_at IS NULL
          AND (?1 IS NULL OR a.jenis_dokumen_id = ?1)
          AND (?2 IS NULL OR a.uploaded_at > ?2 OR (a.uploaded_at = ?2 AND a.id > ?3))
        ORDER BY a.uploaded_at, a.id
        LIMIT ?4`,
    )
    .bind(jenisId, cursor?.uploadedAt ?? null, cursor?.id ?? 0, limit);
}

/** Pending count per jenis (ignores any filter). */
export function selectPendingPerJenis(db: D1Database): D1PreparedStatement {
  return db.prepare(
    `SELECT a.jenis_dokumen_id AS jenis_id, COUNT(*) AS n
       FROM arsip_dokumen a
       JOIN pegawai p ON p.id = a.pegawai_id AND p.deleted_at IS NULL
      WHERE a.status = 'Menunggu' AND a.deleted_at IS NULL
      GROUP BY a.jenis_dokumen_id`,
  );
}

export function selectPendingCount(db: D1Database): D1PreparedStatement {
  return db.prepare(
    `SELECT COUNT(*) AS n
       FROM arsip_dokumen a
       JOIN pegawai p ON p.id = a.pegawai_id AND p.deleted_at IS NULL
      WHERE a.status = 'Menunggu' AND a.deleted_at IS NULL`,
  );
}

export interface DecisionTargetRow {
  id: number;
  pegawai_id: number;
  jenis_dokumen_id: string;
  status: StatusDokumen;
  versi: number;
  deleted_at: string | null;
  pegawai_nama: string;
  no_hp: string | null;
  jenis_nama: string;
}

/** Arsip of a non-deleted pegawai + names/phone needed for the notification. */
export function selectDecisionTarget(db: D1Database, arsipId: number): D1PreparedStatement {
  return db
    .prepare(
      `SELECT a.id, a.pegawai_id, a.jenis_dokumen_id, a.status, a.versi, a.deleted_at,
              p.nama AS pegawai_nama, p.no_hp, j.nama AS jenis_nama
         FROM arsip_dokumen a
         JOIN pegawai p ON p.id = a.pegawai_id AND p.deleted_at IS NULL
         JOIN jenis_dokumen j ON j.id = a.jenis_dokumen_id
        WHERE a.id = ?1`,
    )
    .bind(arsipId);
}

/** Compare-and-set decision: only an active, still-pending arsip at the expected versi. */
export function decideArsip(
  db: D1Database,
  arsipId: number,
  expectedVersi: number,
  status: 'Terverifikasi' | 'Ditolak',
  adminId: number,
  nowIso: string,
  catatan: string | null,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE arsip_dokumen
          SET status = ?3, verified_at = ?5, verified_by = ?4, catatan_admin = ?6
        WHERE id = ?1 AND versi = ?2 AND status = 'Menunggu' AND deleted_at IS NULL`,
    )
    .bind(arsipId, expectedVersi, status, adminId, nowIso, catatan);
}
