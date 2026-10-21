// SQL helpers for Phase 7 administration: activity log, reference tables and
// document types. Mutations return prepared statements so the service batches
// them with the audit row (MIGRATION_PLAN §3.1 rule 10). Table and column names
// are fixed literals here; callers only ever supply bound values.

// ---------------------------------------------------------------------------
// Activity log
// ---------------------------------------------------------------------------

export interface LogRow {
  id: number;
  ts: string;
  actor_id: number | null;
  actor_nip: string | null;
  actor_nama: string | null;
  actor_role: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  description: string | null;
  result: string;
}

export interface LogFilter {
  /** Already LIKE-escaped (`\` escape), wrapped in `%…%`. */
  likePattern: string | null;
  /** Half-open action ranges [lo, hi) — one per whitelisted prefix. */
  actionRanges: readonly (readonly [string, string])[];
  result: string | null;
  fromIso: string | null;
  toIso: string | null;
  cursor: { ts: string; id: number } | null;
  limit: number;
}

/** Keyset page ordered ts DESC, id DESC. Every value is bound; the SQL shape is fixed. */
export function selectLogPage(db: D1Database, f: LogFilter): D1PreparedStatement {
  const where: string[] = [];
  const binds: unknown[] = [];
  const p = (v: unknown) => {
    binds.push(v);
    return `?${binds.length}`;
  };
  if (f.likePattern !== null) {
    const q = p(f.likePattern);
    where.push(
      `(description LIKE ${q} ESCAPE '\\' OR action LIKE ${q} ESCAPE '\\'` +
        ` OR actor_nama LIKE ${q} ESCAPE '\\' OR actor_nip LIKE ${q} ESCAPE '\\')`,
    );
  }
  if (f.actionRanges.length) {
    where.push(`(${f.actionRanges.map(([lo, hi]) => `(action >= ${p(lo)} AND action < ${p(hi)})`).join(' OR ')})`);
  }
  if (f.result !== null) where.push(`result = ${p(f.result)}`);
  if (f.fromIso !== null) where.push(`ts >= ${p(f.fromIso)}`);
  if (f.toIso !== null) where.push(`ts < ${p(f.toIso)}`);
  if (f.cursor) {
    const ts = p(f.cursor.ts);
    const id = p(f.cursor.id);
    where.push(`(ts < ${ts} OR (ts = ${ts} AND id < ${id}))`);
  }
  const lim = p(f.limit);
  return db
    .prepare(
      `SELECT id, ts, actor_id, actor_nip, actor_nama, actor_role, action, target_type, target_id, description, result
         FROM log_aktivitas
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY ts DESC, id DESC
        LIMIT ${lim}`,
    )
    .bind(...binds);
}

// ---------------------------------------------------------------------------
// Reference tables
// ---------------------------------------------------------------------------

export interface PangkatRow {
  kode: string;
  nama: string;
  jenis_asn: 'PNS' | 'PPPK';
  urutan: number;
  aktif: number;
}
export interface UnitRow {
  id: number;
  nama: string;
  aktif: number;
}
export interface PendidikanRow {
  kode: string;
  nama: string;
  urutan: number;
}

export function selectAllPangkat(db: D1Database): D1PreparedStatement {
  return db.prepare(`SELECT kode, nama, jenis_asn, urutan, aktif FROM ref_pangkat_golongan ORDER BY urutan, nama, kode`);
}
export function selectAllUnit(db: D1Database): D1PreparedStatement {
  return db.prepare(`SELECT id, nama, aktif FROM ref_unit_organisasi ORDER BY nama, id`);
}
export function selectAllPendidikan(db: D1Database): D1PreparedStatement {
  return db.prepare(`SELECT kode, nama, urutan FROM ref_pendidikan ORDER BY urutan, kode`);
}

export function selectPangkat(db: D1Database, kode: string): D1PreparedStatement {
  return db.prepare(`SELECT kode, nama, jenis_asn, urutan, aktif FROM ref_pangkat_golongan WHERE kode = ?1`).bind(kode);
}
export function selectUnit(db: D1Database, id: number): D1PreparedStatement {
  return db.prepare(`SELECT id, nama, aktif FROM ref_unit_organisasi WHERE id = ?1`).bind(id);
}

// Uniqueness (case-insensitive) is enforced by the write statements themselves
// (INSERT … SELECT … WHERE NOT EXISTS / UPDATE … AND NOT EXISTS), so a check and its
// write are one atomic statement; these reads only explain WHY a guarded write was a no-op.
const PANGKAT_KODE_TAKEN = (k: string, except: string) =>
  `EXISTS(SELECT 1 FROM ref_pangkat_golongan WHERE kode = ${k} COLLATE NOCASE AND (${except} IS NULL OR kode <> ${except}))`;
const PANGKAT_NAMA_TAKEN = (n: string, except: string) =>
  `EXISTS(SELECT 1 FROM ref_pangkat_golongan WHERE nama = ${n} COLLATE NOCASE AND (${except} IS NULL OR kode <> ${except}))`;
const UNIT_NAMA_TAKEN = (n: string, except: string) =>
  `EXISTS(SELECT 1 FROM ref_unit_organisasi WHERE nama = ${n} COLLATE NOCASE AND (${except} IS NULL OR id <> ${except}))`;

/** Which unique pangkat fields are already held by another row (`null` = not checked). */
export function pangkatConflicts(
  db: D1Database,
  kode: string | null,
  nama: string | null,
  exceptKode: string | null,
): D1PreparedStatement {
  return db
    .prepare(
      `SELECT (?1 IS NOT NULL AND ${PANGKAT_KODE_TAKEN('?1', '?3')}) AS kode,
              (?2 IS NOT NULL AND ${PANGKAT_NAMA_TAKEN('?2', '?3')}) AS nama`,
    )
    .bind(kode, nama, exceptKode);
}
export function unitNamaConflict(db: D1Database, nama: string, exceptId: number | null): D1PreparedStatement {
  return db.prepare(`SELECT ${UNIT_NAMA_TAKEN('?1', '?2')} AS nama`).bind(nama, exceptId);
}

export function insertPangkat(db: D1Database, r: PangkatRow): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO ref_pangkat_golongan (kode, nama, jenis_asn, urutan, aktif)
       SELECT ?1, ?2, ?3, ?4, ?5
        WHERE NOT ${PANGKAT_KODE_TAKEN('?1', 'NULL')} AND NOT ${PANGKAT_NAMA_TAKEN('?2', 'NULL')}`,
    )
    .bind(r.kode, r.nama, r.jenis_asn, r.urutan, r.aktif);
}

/** Partial update; `null` keeps the column. kode/jenis_asn are never written. */
export function updatePangkat(
  db: D1Database,
  kode: string,
  v: { nama: string | null; urutan: number | null; aktif: number | null },
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE ref_pangkat_golongan
          SET nama = COALESCE(?2, nama), urutan = COALESCE(?3, urutan), aktif = COALESCE(?4, aktif)
        WHERE kode = ?1 AND (?2 IS NULL OR NOT ${PANGKAT_NAMA_TAKEN('?2', '?1')})`,
    )
    .bind(kode, v.nama, v.urutan, v.aktif);
}

export function insertUnit(db: D1Database, nama: string, aktif: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO ref_unit_organisasi (nama, aktif)
       SELECT ?1, ?2 WHERE NOT ${UNIT_NAMA_TAKEN('?1', 'NULL')}
       RETURNING id, nama, aktif`,
    )
    .bind(nama, aktif);
}
export function updateUnit(db: D1Database, id: number, v: { nama: string | null; aktif: number | null }): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE ref_unit_organisasi SET nama = COALESCE(?2, nama), aktif = COALESCE(?3, aktif)
        WHERE id = ?1 AND (?2 IS NULL OR NOT ${UNIT_NAMA_TAKEN('?2', '?1')})`,
    )
    .bind(id, v.nama, v.aktif);
}

// ---------------------------------------------------------------------------
// Jenis dokumen + required matrix
// ---------------------------------------------------------------------------

export interface JenisRow {
  id: string;
  nama: string;
  kategori: string;
  urutan: number;
  aktif: number;
  max_size_bytes: number;
  updated_at: string;
  /** JSON array of status_kepegawaian (json_group_array). */
  wajib: string;
}

const JENIS_SELECT = `
  SELECT j.id, j.nama, j.kategori, j.urutan, j.aktif, j.max_size_bytes, j.updated_at,
         COALESCE((SELECT json_group_array(w.status_kepegawaian)
                     FROM (SELECT status_kepegawaian FROM jenis_dokumen_wajib
                            WHERE jenis_dokumen_id = j.id ORDER BY status_kepegawaian) w), '[]') AS wajib
    FROM jenis_dokumen j`;

export function selectAllJenis(db: D1Database): D1PreparedStatement {
  return db.prepare(`${JENIS_SELECT} ORDER BY j.urutan, j.nama, j.id`);
}
export function selectJenis(db: D1Database, id: string): D1PreparedStatement {
  return db.prepare(`${JENIS_SELECT} WHERE j.id = ?1`).bind(id);
}

export function insertJenis(
  db: D1Database,
  r: Omit<JenisRow, 'wajib'>,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO jenis_dokumen (id, nama, kategori, urutan, aktif, max_size_bytes, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
    .bind(r.id, r.nama, r.kategori, r.urutan, r.aktif, r.max_size_bytes, r.updated_at);
}

/** Plain matrix insert, for a type created in the same batch (PK failure rolls everything back). */
export function insertWajib(db: D1Database, id: string, statuses: readonly string[]): D1PreparedStatement {
  return db
    .prepare(`INSERT INTO jenis_dokumen_wajib (jenis_dokumen_id, status_kepegawaian) SELECT ?1, value FROM json_each(?2)`)
    .bind(id, JSON.stringify(statuses));
}

// Compare-and-set for PATCH. Every statement is gated by the stamp the service READ
// (`oldStamp`), not the one it is about to write: D1 runs a batch as one serialized
// transaction, so all statements of a batch see the same pre-update stamp, while any
// other writer that read the same stamp sees a strictly newer one (stamps only ever
// increase) and therefore changes nothing — no matrix DELETE, no INSERT, no audit.
// The matrix statements run BEFORE the jenis UPDATE so their gate is still intact.
const CAS = `EXISTS (SELECT 1 FROM jenis_dokumen WHERE id = ?1 AND updated_at = ?2)`;

export function deleteWajibIfStamp(db: D1Database, id: string, oldStamp: string): D1PreparedStatement {
  return db.prepare(`DELETE FROM jenis_dokumen_wajib WHERE jenis_dokumen_id = ?1 AND ${CAS}`).bind(id, oldStamp);
}
export function insertWajibIfStamp(
  db: D1Database,
  id: string,
  oldStamp: string,
  statuses: readonly string[],
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO jenis_dokumen_wajib (jenis_dokumen_id, status_kepegawaian)
       SELECT ?1, value FROM json_each(?3) WHERE ${CAS}`,
    )
    .bind(id, oldStamp, JSON.stringify(statuses));
}

/** Partial update + stamp bump, CAS on `oldStamp`. Must be the LAST gated write (audit follows it). */
export function updateJenisIfStamp(
  db: D1Database,
  id: string,
  oldStamp: string,
  newStamp: string,
  v: { nama: string | null; kategori: string | null; urutan: number | null; aktif: number | null; maxSizeBytes: number | null },
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE jenis_dokumen
          SET nama = COALESCE(?4, nama), kategori = COALESCE(?5, kategori), urutan = COALESCE(?6, urutan),
              aktif = COALESCE(?7, aktif), max_size_bytes = COALESCE(?8, max_size_bytes), updated_at = ?3
        WHERE id = ?1 AND updated_at = ?2`,
    )
    .bind(id, oldStamp, newStamp, v.nama, v.kategori, v.urutan, v.aktif, v.maxSizeBytes);
}
