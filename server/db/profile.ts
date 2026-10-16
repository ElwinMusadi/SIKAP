// SQL helpers for profile, reference data, photo and the employee dashboard.
import type {
  Agama,
  GolonganDarah,
  JenisJabatan,
  JenisKelamin,
  StatusDokumen,
  StatusKepegawaian,
  StatusPengajuan,
  StatusPernikahan,
} from '../../shared/enums';
import type { KepegawaianField, Pengajuan, PerubahanMap, Profile } from '../../shared/profile';
import { photoUrl } from '../lib/photo-url';

/** Full `pegawai` row (snake_case, as stored). */
export interface PegawaiRow {
  id: number;
  nip: string;
  nik: string | null;
  nama: string;
  role: 'Admin' | 'Pegawai';
  status_akun: 'Aktif' | 'Nonaktif';
  status_kepegawaian: StatusKepegawaian | null;
  pangkat_kode: string | null;
  tmt_pangkat: string | null;
  jabatan: string | null;
  jenis_jabatan: JenisJabatan | null;
  tmt_jabatan: string | null;
  unit_id: number | null;
  tempat_lahir: string | null;
  tanggal_lahir: string | null;
  jenis_kelamin: JenisKelamin | null;
  agama: Agama | null;
  pendidikan_kode: string | null;
  status_pernikahan: StatusPernikahan | null;
  golongan_darah: GolonganDarah | null;
  no_hp: string | null;
  email: string | null;
  alamat: string | null;
  foto_r2_key: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  deleted_by: number | null;
  purge_after: string | null;
}

export function rowToProfile(row: PegawaiRow): Profile {
  return {
    id: row.id,
    nip: row.nip,
    nama: row.nama,
    role: row.role,
    statusAkun: row.status_akun,
    fotoUrl: row.foto_r2_key ? photoUrl(row.id, row.foto_r2_key) : null,
    nik: row.nik,
    tempatLahir: row.tempat_lahir,
    tanggalLahir: row.tanggal_lahir,
    jenisKelamin: row.jenis_kelamin,
    agama: row.agama,
    pendidikanKode: row.pendidikan_kode,
    statusPernikahan: row.status_pernikahan,
    golonganDarah: row.golongan_darah,
    noHp: row.no_hp,
    email: row.email,
    alamat: row.alamat,
    statusKepegawaian: row.status_kepegawaian,
    pangkatKode: row.pangkat_kode,
    tmtPangkat: row.tmt_pangkat,
    jabatan: row.jabatan,
    jenisJabatan: row.jenis_jabatan,
    tmtJabatan: row.tmt_jabatan,
    unitId: row.unit_id,
    updatedAt: row.updated_at,
  };
}

/** Editable profile fields: camelCase request key → snake_case column. */
export const PROFILE_COLUMN_MAP = {
  nik: 'nik',
  tempatLahir: 'tempat_lahir',
  tanggalLahir: 'tanggal_lahir',
  jenisKelamin: 'jenis_kelamin',
  agama: 'agama',
  pendidikanKode: 'pendidikan_kode',
  statusPernikahan: 'status_pernikahan',
  golonganDarah: 'golongan_darah',
  noHp: 'no_hp',
  email: 'email',
  alamat: 'alamat',
} as const;
export type EditableProfileKey = keyof typeof PROFILE_COLUMN_MAP;

/** Employment fields (changed only via pengajuan or by admin): camelCase → column. */
export const KEPEGAWAIAN_COLUMN_MAP = {
  statusKepegawaian: 'status_kepegawaian',
  pangkatKode: 'pangkat_kode',
  tmtPangkat: 'tmt_pangkat',
  jabatan: 'jabatan',
  jenisJabatan: 'jenis_jabatan',
  tmtJabatan: 'tmt_jabatan',
  unitId: 'unit_id',
} as const satisfies Record<KepegawaianField, keyof PegawaiRow>;
export type KepegawaianColumn = (typeof KEPEGAWAIAN_COLUMN_MAP)[KepegawaianField];

export function selectPegawaiById(db: D1Database, id: number): D1PreparedStatement {
  return db.prepare(`SELECT * FROM pegawai WHERE id = ?1 AND deleted_at IS NULL`).bind(id);
}

// ---------------------------------------------------------------------------
// Pengajuan (pending)
// ---------------------------------------------------------------------------

export interface PengajuanRow {
  id: number;
  pegawai_id: number;
  perubahan: string;
  alasan: string | null;
  status: StatusPengajuan;
  catatan_admin: string | null;
  created_at: string;
  reviewed_at: string | null;
  reviewed_by: number | null;
}

export function selectPendingPengajuan(db: D1Database, pegawaiId: number): D1PreparedStatement {
  return db
    .prepare(
      `SELECT id, pegawai_id, perubahan, alasan, status, catatan_admin, created_at, reviewed_at, reviewed_by
         FROM pengajuan_perubahan WHERE pegawai_id = ?1 AND status = 'Menunggu' LIMIT 1`,
    )
    .bind(pegawaiId);
}

/** Pending requests are never reviewed yet, so `reviewedBy` is always null here. */
export function rowToPendingPengajuan(row: PengajuanRow): Pengajuan {
  return {
    id: row.id,
    pegawaiId: row.pegawai_id,
    perubahan: JSON.parse(row.perubahan) as PerubahanMap,
    alasan: row.alasan,
    status: row.status,
    catatanAdmin: row.catatan_admin,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
    reviewedBy: null,
  };
}

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

export interface RefPangkatRow {
  kode: string;
  nama: string;
  jenis_asn: 'PNS' | 'PPPK';
}
export interface RefUnitRow {
  id: number;
  nama: string;
}
export interface RefPendidikanRow {
  kode: string;
  nama: string;
}
export interface RefJenisDokumenRow {
  id: string;
  nama: string;
  kategori: string;
  max_size_bytes: number;
}
export interface RefWajibRow {
  jenis_dokumen_id: string;
  status_kepegawaian: StatusKepegawaian;
}

export function refStatements(db: D1Database): [
  D1PreparedStatement,
  D1PreparedStatement,
  D1PreparedStatement,
  D1PreparedStatement,
  D1PreparedStatement,
] {
  return [
    db.prepare(`SELECT kode, nama, jenis_asn FROM ref_pangkat_golongan WHERE aktif = 1 ORDER BY urutan, nama`),
    db.prepare(`SELECT id, nama FROM ref_unit_organisasi WHERE aktif = 1 ORDER BY nama, id`),
    db.prepare(`SELECT kode, nama FROM ref_pendidikan ORDER BY urutan, nama`),
    db.prepare(
      `SELECT id, nama, kategori, max_size_bytes FROM jenis_dokumen WHERE aktif = 1 ORDER BY urutan, nama, id`,
    ),
    db.prepare(`SELECT jenis_dokumen_id, status_kepegawaian FROM jenis_dokumen_wajib ORDER BY status_kepegawaian`),
  ];
}

/** One row when the pendidikan code exists. */
export function pendidikanExists(db: D1Database, kode: string): D1PreparedStatement {
  return db.prepare(`SELECT 1 AS ok FROM ref_pendidikan WHERE kode = ?1`).bind(kode);
}

/** One row when another pegawai (including soft-deleted: UNIQUE still applies) holds this NIK. */
export function nikUsedByOther(db: D1Database, nik: string, id: number): D1PreparedStatement {
  return db.prepare(`SELECT 1 AS ok FROM pegawai WHERE nik = ?1 AND id <> ?2 LIMIT 1`).bind(nik, id);
}

// ---------------------------------------------------------------------------
// Photo
// ---------------------------------------------------------------------------

export function selectFotoKey(db: D1Database, id: number): Promise<{ foto_r2_key: string | null } | null> {
  return db
    .prepare(`SELECT foto_r2_key FROM pegawai WHERE id = ?1 AND deleted_at IS NULL`)
    .bind(id)
    .first<{ foto_r2_key: string | null }>();
}

/** Compare-and-set: only succeeds if the key is still `oldKey` (NULL-safe `IS`). */
export function updateFotoKey(
  db: D1Database,
  id: number,
  key: string,
  oldKey: string | null,
  nowIso: string,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE pegawai SET foto_r2_key = ?2, updated_at = ?3
        WHERE id = ?1 AND deleted_at IS NULL AND foto_r2_key IS ?4`,
    )
    .bind(id, key, nowIso, oldKey);
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export interface DashboardDocRow {
  id: string;
  nama: string;
  kategori: string;
  urutan: number;
  status: StatusDokumen | null;
  catatan_admin: string | null;
  uploaded_at: string | null;
  verified_at: string | null;
  wajib: number;
}

/** Active document types with this employee's arsip state; `status` '' makes `wajib` false. */
export function dashboardDocs(db: D1Database, pegawaiId: number, status: StatusKepegawaian | ''): D1PreparedStatement {
  return db
    .prepare(
      `SELECT j.id, j.nama, j.kategori, j.urutan, a.status, a.catatan_admin, a.uploaded_at, a.verified_at,
              EXISTS(SELECT 1 FROM jenis_dokumen_wajib w
                      WHERE w.jenis_dokumen_id = j.id AND w.status_kepegawaian = ?2) AS wajib
         FROM jenis_dokumen j
         LEFT JOIN arsip_dokumen a
           ON a.jenis_dokumen_id = j.id AND a.pegawai_id = ?1 AND a.deleted_at IS NULL
        WHERE j.aktif = 1
        ORDER BY j.urutan, j.nama`,
    )
    .bind(pegawaiId, status);
}
