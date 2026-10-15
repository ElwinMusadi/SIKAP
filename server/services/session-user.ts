import type { SessionUser } from '../../shared/api';
import type { AuthUser } from '../env';

interface UserLikeRow {
  id: number;
  nip: string;
  nama: string;
  role: AuthUser['role'];
  status_kepegawaian: AuthUser['statusKepegawaian'];
  jabatan: string | null;
  foto_r2_key: string | null;
  is_default_password: number;
}

export function rowToAuthUser(row: UserLikeRow): AuthUser {
  return {
    id: row.id,
    nip: row.nip,
    nama: row.nama,
    role: row.role,
    statusKepegawaian: row.status_kepegawaian,
    jabatan: row.jabatan,
    fotoR2Key: row.foto_r2_key,
    isDefaultPassword: row.is_default_password === 1,
  };
}

/** Public DTO (shared/api.ts). Never exposes the R2 key itself. */
export function toSessionUser(user: AuthUser): SessionUser {
  return {
    id: user.id,
    nip: user.nip,
    nama: user.nama,
    role: user.role,
    statusKepegawaian: user.statusKepegawaian,
    jabatan: user.jabatan,
    fotoUrl: user.fotoR2Key ? `/api/pegawai/${user.id}/photo` : null,
    isDefaultPassword: user.isDefaultPassword,
  };
}
