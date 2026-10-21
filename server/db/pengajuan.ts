// SQL helpers for pengajuan perubahan data kepegawaian (owner decision #6).
import type { StatusKepegawaian, StatusPengajuan } from '../../shared/enums';
import type { KepegawaianField, KepegawaianValue, Pengajuan, PerubahanMap } from '../../shared/profile';
import { KEPEGAWAIAN_COLUMN_MAP, type PengajuanRow } from './profile';

/** Pengajuan row plus the reviewer's name (LEFT JOIN; null when unreviewed or purged). */
export interface PengajuanWithReviewerRow extends PengajuanRow {
  reviewer_nama: string | null;
}

export function rowToPengajuan(row: PengajuanWithReviewerRow): Pengajuan {
  return {
    id: row.id,
    pegawaiId: row.pegawai_id,
    perubahan: JSON.parse(row.perubahan) as PerubahanMap,
    alasan: row.alasan,
    status: row.status,
    catatanAdmin: row.catatan_admin,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
    reviewedBy:
      row.reviewed_by != null && row.reviewer_nama != null ? { id: row.reviewed_by, nama: row.reviewer_nama } : null,
  };
}

const SELECT_WITH_REVIEWER = `
  SELECT p.id, p.pegawai_id, p.perubahan, p.alasan, p.status, p.catatan_admin,
         p.created_at, p.reviewed_at, p.reviewed_by, r.nama AS reviewer_nama
    FROM pengajuan_perubahan p
    LEFT JOIN pegawai r ON r.id = p.reviewed_by`;

export function selectPengajuanById(db: D1Database, id: number): D1PreparedStatement {
  return db.prepare(`${SELECT_WITH_REVIEWER} WHERE p.id = ?1`).bind(id);
}

export function selectOwnPengajuan(db: D1Database, pegawaiId: number, limit = 20): D1PreparedStatement {
  return db
    .prepare(`${SELECT_WITH_REVIEWER} WHERE p.pegawai_id = ?1 ORDER BY p.created_at DESC, p.id DESC LIMIT ?2`)
    .bind(pegawaiId, limit);
}

export function insertPengajuan(
  db: D1Database,
  pegawaiId: number,
  perubahan: PerubahanMap,
  alasan: string,
  nowIso: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO pengajuan_perubahan (pegawai_id, perubahan, alasan, status, created_at)
       VALUES (?1, ?2, ?3, 'Menunggu', ?4) RETURNING id`,
    )
    .bind(pegawaiId, JSON.stringify(perubahan), alasan, nowIso);
}

export function selectOwnPengajuanById(db: D1Database, id: number, pegawaiId: number): D1PreparedStatement {
  return db.prepare(`${SELECT_WITH_REVIEWER} WHERE p.id = ?1 AND p.pegawai_id = ?2`).bind(id, pegawaiId);
}

/** Owner cancel: reviewed_at records when it left the queue; reviewed_by stays NULL. */
export function cancelPengajuan(db: D1Database, id: number, pegawaiId: number, nowIso: string): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE pengajuan_perubahan SET status = 'Dibatalkan', reviewed_at = ?3
        WHERE id = ?1 AND pegawai_id = ?2 AND status = 'Menunggu'`,
    )
    .bind(id, pegawaiId, nowIso);
}

/** Current pangkat of a pegawai with its ASN family (no row when pangkat is null). */
export function selectCurrentPangkat(db: D1Database, pegawaiId: number): D1PreparedStatement {
  return db
    .prepare(
      `SELECT g.kode, g.jenis_asn FROM pegawai p
         JOIN ref_pangkat_golongan g ON g.kode = p.pangkat_kode
        WHERE p.id = ?1`,
    )
    .bind(pegawaiId);
}

/** Conditional transition out of 'Menunggu'; 0 changes = already processed (lost race). */
export function reviewPengajuan(
  db: D1Database,
  id: number,
  status: Extract<StatusPengajuan, 'Disetujui' | 'Ditolak'>,
  adminId: number,
  catatan: string | null,
  nowIso: string,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE pengajuan_perubahan
          SET status = ?2, reviewed_at = ?3, reviewed_by = ?4, catatan_admin = ?5
        WHERE id = ?1 AND status = 'Menunggu'
          AND EXISTS (SELECT 1 FROM pegawai g
                       WHERE g.id = pengajuan_perubahan.pegawai_id AND g.deleted_at IS NULL)`,
    )
    .bind(id, status, nowIso, adminId, catatan);
}

/**
 * Apply approved values to pegawai, guarded by EXISTS on the approval written by
 * the preceding statement of the same batch (same now + admin). If that UPDATE
 * matched nothing (already processed / cancelled / raced), this one is a no-op.
 * Columns come from KEPEGAWAIAN_COLUMN_MAP only — never from JSON keys.
 */
export function applyApprovedPerubahan(
  db: D1Database,
  pengajuanId: number,
  pegawaiId: number,
  values: Partial<Record<KepegawaianField, KepegawaianValue>>,
  adminId: number,
  nowIso: string,
): D1PreparedStatement {
  const fields = (Object.keys(KEPEGAWAIAN_COLUMN_MAP) as KepegawaianField[]).filter((f) => f in values);
  const sets = fields.map((f, i) => `${KEPEGAWAIAN_COLUMN_MAP[f]} = ?${i + 5}`);
  sets.push('updated_at = ?3');
  return db
    .prepare(
      `UPDATE pegawai SET ${sets.join(', ')}
        WHERE id = ?1 AND deleted_at IS NULL
          AND changes() > 0
          AND EXISTS (SELECT 1 FROM pengajuan_perubahan
                       WHERE id = ?2 AND status = 'Disetujui' AND reviewed_at = ?3 AND reviewed_by = ?4)`,
    )
    .bind(pegawaiId, pengajuanId, nowIso, adminId, ...fields.map((f) => values[f] ?? null));
}

// ---------------------------------------------------------------------------
// Reference checks
// ---------------------------------------------------------------------------

export function selectPangkat(db: D1Database, kode: string): D1PreparedStatement {
  return db.prepare(`SELECT kode, jenis_asn FROM ref_pangkat_golongan WHERE kode = ?1 AND aktif = 1`).bind(kode);
}

export function selectUnit(db: D1Database, id: number): D1PreparedStatement {
  return db.prepare(`SELECT id FROM ref_unit_organisasi WHERE id = ?1 AND aktif = 1`).bind(id);
}

// ---------------------------------------------------------------------------
// Admin list
// ---------------------------------------------------------------------------

export interface AdminPengajuanRow extends PengajuanWithReviewerRow {
  pegawai_nip: string;
  pegawai_nama: string;
  status_kepegawaian: StatusKepegawaian | null;
  pangkat_kode: string | null;
  tmt_pangkat: string | null;
  jabatan: string | null;
  jenis_jabatan: string | null;
  tmt_jabatan: string | null;
  unit_id: number | null;
}

export function selectAdminPengajuan(db: D1Database, status: StatusPengajuan, limit = 100): D1PreparedStatement {
  // Literal ORDER BY per branch: oldest pending first (queue), newest first otherwise.
  const order = status === 'Menunggu' ? 'p.created_at ASC, p.id ASC' : 'p.created_at DESC, p.id DESC';
  return db
    .prepare(
      `SELECT p.id, p.pegawai_id, p.perubahan, p.alasan, p.status, p.catatan_admin,
              p.created_at, p.reviewed_at, p.reviewed_by, r.nama AS reviewer_nama,
              g.nip AS pegawai_nip, g.nama AS pegawai_nama, g.status_kepegawaian, g.pangkat_kode,
              g.tmt_pangkat, g.jabatan, g.jenis_jabatan, g.tmt_jabatan, g.unit_id
         FROM pengajuan_perubahan p
         JOIN pegawai g ON g.id = p.pegawai_id AND g.deleted_at IS NULL
         LEFT JOIN pegawai r ON r.id = p.reviewed_by
        WHERE p.status = ?1
        ORDER BY ${order}
        LIMIT ?2`,
    )
    .bind(status, limit);
}

export function countPengajuanByStatus(db: D1Database): D1PreparedStatement {
  return db.prepare(
    `SELECT p.status, COUNT(*) AS n
       FROM pengajuan_perubahan p
       JOIN pegawai g ON g.id = p.pegawai_id AND g.deleted_at IS NULL
      GROUP BY p.status`,
  );
}

/** Pengajuan row + the owner's CURRENT employment state, for approve/reject pre-checks. */
export interface PengajuanReviewRow extends PengajuanRow {
  pegawai_deleted_at: string | null;
  cur_status_kepegawaian: StatusKepegawaian | null;
  cur_pangkat_kode: string | null;
}

export function selectPengajuanForReview(db: D1Database, id: number): D1PreparedStatement {
  return db
    .prepare(
      `SELECT p.id, p.pegawai_id, p.perubahan, p.alasan, p.status, p.catatan_admin,
              p.created_at, p.reviewed_at, p.reviewed_by, g.deleted_at AS pegawai_deleted_at,
              g.status_kepegawaian AS cur_status_kepegawaian, g.pangkat_kode AS cur_pangkat_kode
         FROM pengajuan_perubahan p JOIN pegawai g ON g.id = p.pegawai_id
        WHERE p.id = ?1`,
    )
    .bind(id);
}

/**
 * Reference rows needed to re-validate an approval, in one statement: every
 * pangkat the result could involve (requested and current) and the requested unit.
 * Reads values from the stored JSON in SQL, so no second round trip is needed.
 */
export interface ReviewRefRow {
  kind: 'pangkat' | 'unit';
  ref: string;
  jenis_asn: 'PNS' | 'PPPK' | null;
  aktif: number;
}

export function selectReviewRefs(db: D1Database, pengajuanId: number): D1PreparedStatement {
  return db
    .prepare(
      `SELECT 'pangkat' AS kind, r.kode AS ref, r.jenis_asn, r.aktif
         FROM pengajuan_perubahan p
         JOIN pegawai g ON g.id = p.pegawai_id
         JOIN ref_pangkat_golongan r
           ON r.kode IN (json_extract(p.perubahan, '$.pangkatKode.baru'), g.pangkat_kode)
        WHERE p.id = ?1
       UNION ALL
       SELECT 'unit', CAST(u.id AS TEXT), NULL, u.aktif
         FROM pengajuan_perubahan p
         JOIN ref_unit_organisasi u ON u.id = json_extract(p.perubahan, '$.unitId.baru')
        WHERE p.id = ?1`,
    )
    .bind(pengajuanId);
}
