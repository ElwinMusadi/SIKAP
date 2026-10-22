// Integration API data access: `kunci_api` rows and the read-only employee projections served
// by /api/v1 (contract: shared/integrasi.ts). Projections whitelist columns; never `SELECT p.*`.

import type { JenisJabatan, StatusKepegawaian } from '../../shared/enums';
import { likePattern } from './pegawai';

// ---------------------------------------------------------------------------
// kunci_api
// ---------------------------------------------------------------------------

export interface KunciApiRow {
  id: number;
  id_publik: string;
  token_hash: string;
  nama: string;
  keterangan: string | null;
  izin: string;
  created_at: string;
  created_by: number | null;
  created_by_nama: string | null;
  expires_at: string;
  last_used_at: string | null;
  last_used_ip: string | null;
}

const KUNCI_COLUMNS = `id, id_publik, token_hash, nama, keterangan, izin, created_at, created_by, created_by_nama,
  expires_at, last_used_at, last_used_ip`;

export function selectKunciByPublicId(db: D1Database, idPublik: string): Promise<KunciApiRow | null> {
  return db.prepare(`SELECT ${KUNCI_COLUMNS} FROM kunci_api WHERE id_publik = ?1`).bind(idPublik).first<KunciApiRow>();
}

export function selectKunciById(db: D1Database, id: number): Promise<KunciApiRow | null> {
  return db.prepare(`SELECT ${KUNCI_COLUMNS} FROM kunci_api WHERE id = ?1`).bind(id).first<KunciApiRow>();
}

export async function selectAllKunci(db: D1Database): Promise<KunciApiRow[]> {
  const { results } = await db.prepare(`SELECT ${KUNCI_COLUMNS} FROM kunci_api ORDER BY created_at DESC, id DESC`).all<KunciApiRow>();
  return results;
}

export interface NewKunci {
  idPublik: string;
  tokenHash: string;
  nama: string;
  keterangan: string | null;
  izin: readonly string[];
  createdAt: string;
  createdBy: number;
  createdByNama: string;
  expiresAt: string;
}

/** INSERT … RETURNING; follow it directly with an audit statement using `targetIdFromLastInsert`. */
export function insertKunci(db: D1Database, k: NewKunci): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO kunci_api (id_publik, token_hash, nama, keterangan, izin, created_at, created_by, created_by_nama, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
       RETURNING ${KUNCI_COLUMNS}`,
    )
    .bind(k.idPublik, k.tokenHash, k.nama, k.keterangan, JSON.stringify(k.izin), k.createdAt, k.createdBy, k.createdByNama, k.expiresAt);
}

export function deleteKunci(db: D1Database, id: number): D1PreparedStatement {
  return db.prepare(`DELETE FROM kunci_api WHERE id = ?1`).bind(id);
}

/** Records use at most once per `floorIso` window, so busy clients do not write D1 on every request. */
export function touchKunci(db: D1Database, id: number, nowIso: string, ip: string | null, floorIso: string): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE kunci_api SET last_used_at = ?2, last_used_ip = ?3
        WHERE id = ?1 AND (last_used_at IS NULL OR last_used_at <= ?4)`,
    )
    .bind(id, nowIso, ip, floorIso);
}

// ---------------------------------------------------------------------------
// /api/v1/pegawai projections (active employees only, decision #2)
// ---------------------------------------------------------------------------

export interface V1PegawaiRow {
  id: number;
  nip: string;
  nama: string;
  status_kepegawaian: StatusKepegawaian | null;
  pangkat_kode: string | null;
  pangkat_nama: string | null;
  jabatan: string | null;
  jenis_jabatan: JenisJabatan | null;
  unit_id: number | null;
  unit_nama: string | null;
  updated_at: string;
}

export interface V1PegawaiDetailRow extends V1PegawaiRow {
  email: string | null;
  no_hp: string | null;
}

const V1_COLUMNS = `p.id, p.nip, p.nama, p.status_kepegawaian, p.pangkat_kode, g.nama AS pangkat_nama, p.jabatan,
  p.jenis_jabatan, p.unit_id, u.nama AS unit_nama, p.updated_at`;
const V1_FROM = `FROM pegawai p
  LEFT JOIN ref_pangkat_golongan g ON g.kode = p.pangkat_kode
  LEFT JOIN ref_unit_organisasi u ON u.id = p.unit_id`;
const V1_ACTIVE = `p.deleted_at IS NULL AND p.status_akun = 'Aktif'`;

export interface V1PegawaiFilter {
  q?: string;
  statusKepegawaian?: StatusKepegawaian;
  unitId?: number;
  limit: number;
  offset: number;
}

/** [page, total] in one batch. */
export function v1PegawaiListStatements(db: D1Database, f: V1PegawaiFilter): [D1PreparedStatement, D1PreparedStatement] {
  const params: unknown[] = [];
  const p = (v: unknown): string => {
    params.push(v);
    return `?${params.length}`;
  };
  const where = [V1_ACTIVE];
  if (f.q) {
    const pat = p(likePattern(f.q));
    where.push(`(p.nama LIKE ${pat} ESCAPE '\\' OR p.nip LIKE ${pat} ESCAPE '\\')`);
  }
  if (f.statusKepegawaian) where.push(`p.status_kepegawaian = ${p(f.statusKepegawaian)}`);
  if (f.unitId !== undefined) where.push(`p.unit_id = ${p(f.unitId)}`);
  const whereSql = where.join(' AND ');
  const filterParams = [...params];
  const page = db
    .prepare(
      `SELECT ${V1_COLUMNS} ${V1_FROM} WHERE ${whereSql}
       ORDER BY p.nama COLLATE NOCASE ASC, p.id ASC
       LIMIT ${p(f.limit)} OFFSET ${p(f.offset)}`,
    )
    .bind(...params);
  const total = db.prepare(`SELECT COUNT(*) AS total FROM pegawai p WHERE ${whereSql}`).bind(...filterParams);
  return [page, total];
}

export function selectV1PegawaiByNip(db: D1Database, nip: string): Promise<V1PegawaiDetailRow | null> {
  return db
    .prepare(`SELECT ${V1_COLUMNS}, p.email, p.no_hp ${V1_FROM} WHERE p.nip = ?1 AND ${V1_ACTIVE}`)
    .bind(nip)
    .first<V1PegawaiDetailRow>();
}
