// Offline SQL only. The local runner owns empty-target checks, batching and resume.
import { IMPORT_TABLES } from './contract.mjs';

export const COLUMNS = Object.freeze({
  jenis_dokumen: ['id', 'nama', 'kategori', 'urutan', 'aktif', 'max_size_bytes'],
  jenis_dokumen_wajib: ['jenis_dokumen_id', 'status_kepegawaian'],
  pegawai: ['id', 'nip', 'nik', 'nama', 'role', 'status_akun', 'status_kepegawaian', 'pangkat_kode', 'tmt_pangkat', 'jabatan', 'jenis_jabatan', 'tmt_jabatan', 'unit_id', 'tempat_lahir', 'tanggal_lahir', 'jenis_kelamin', 'agama', 'pendidikan_kode', 'status_pernikahan', 'golongan_darah', 'no_hp', 'email', 'alamat', 'foto_r2_key', 'created_at', 'updated_at'],
  akun: ['pegawai_id', 'password_hash', 'is_default_password'],
  arsip_dokumen: ['id', 'pegawai_id', 'jenis_dokumen_id', 'status', 'r2_key', 'file_name', 'mime_type', 'size_bytes', 'sha256', 'versi', 'catatan_admin', 'uploaded_at', 'uploaded_by', 'verified_at', 'verified_by'],
  arsip_dokumen_riwayat: ['id', 'arsip_id', 'versi', 'aksi', 'status', 'catatan', 'actor_id', 'created_at', 'pegawai_id', 'jenis_dokumen_id'],
  log_aktivitas: ['id', 'ts', 'actor_id', 'actor_nip', 'actor_nama', 'actor_role', 'action', 'target_type', 'target_id', 'description', 'result'],
});

export function sqlValue(value) {
  if (value === null) return 'NULL';
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (typeof value !== 'string' || value.includes('\0')) throw new Error('INVALID_SQL_VALUE');
  return `'${value.replaceAll("'", "''")}'`;
}

export function generateSQL(plan) {
  if (plan.ready !== true || plan.diagnostics?.some((d) => d.severity === 'error')) throw new Error('PLAN_NOT_READY');
  if (!plan.tables || Object.keys(plan.tables).some((t) => !IMPORT_TABLES.includes(t))) throw new Error('INVALID_SQL_TABLE');
  const statements = ['-- Sensitive offline import. Empty application target required; runner controls stages.'];
  for (const table of IMPORT_TABLES) {
    if (!Array.isArray(plan.tables[table])) throw new Error('INVALID_SQL_TABLE');
    const columns = COLUMNS[table];
    if (table === 'jenis_dokumen_wajib') {
      // Only source jenis are replaced; never delete unrelated seeded requirements.
      for (const jenis of plan.tables.jenis_dokumen) {
        statements.push(`DELETE FROM jenis_dokumen_wajib WHERE jenis_dokumen_id = ${sqlValue(jenis.id)};`);
      }
    }
    for (const row of plan.tables[table]) {
      if (Object.keys(row).some((column) => !columns.includes(column)) || columns.some((column) => !Object.hasOwn(row, column))) throw new Error('INVALID_SQL_COLUMN');
      let statement = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((c) => sqlValue(row[c])).join(', ')})`;
      if (table === 'jenis_dokumen') {
        statement += ` ON CONFLICT(id) DO UPDATE SET ${columns.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`).join(', ')}`;
      }
      statements.push(`${statement};`);
    }
  }
  return `${statements.join('\n')}\n`;
}
