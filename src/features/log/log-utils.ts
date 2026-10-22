import { LOG_RESULT, type LogResult } from '@shared/enums';
import { LOG_CATEGORIES, logQuerySchema, type LogCategory, type LogItem } from '@shared/administrasi';

export interface LogFilters {
  q: string;
  category: LogCategory | null;
  result: LogResult | null;
  from: string;
  to: string;
}

export const EMPTY_LOG_FILTERS: LogFilters = { q: '', category: null, result: null, from: '', to: '' };

export const CATEGORY_LABELS: Record<LogCategory, string> = {
  auth: 'Autentikasi',
  pegawai: 'Pegawai',
  dokumen: 'Dokumen',
  pengajuan: 'Pengajuan',
  sistem: 'Sistem',
  integrasi: 'Integrasi',
};

export const RESULT_LABELS: Record<LogResult, string> = {
  SUCCESS: 'Berhasil',
  FAILURE: 'Gagal',
  WARNING: 'Peringatan',
  PARTIAL: 'Sebagian',
};

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function pick<T extends string>(value: string | null, allowed: readonly T[]): T | null {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

/** Reads filters from the URL, silently dropping unknown/malformed values. */
export function parseLogFilters(search: URLSearchParams): LogFilters {
  const day = (key: string) => {
    const value = search.get(key) ?? '';
    return ISO_DAY.test(value) ? value : '';
  };
  return {
    q: (search.get('q') ?? '').trim().slice(0, 100),
    category: pick(search.get('category'), LOG_CATEGORIES),
    result: pick(search.get('result'), LOG_RESULT),
    from: day('from'),
    to: day('to'),
  };
}

export function logFiltersToSearch(filters: LogFilters): URLSearchParams {
  const search = new URLSearchParams();
  if (filters.q) search.set('q', filters.q);
  if (filters.category) search.set('category', filters.category);
  if (filters.result) search.set('result', filters.result);
  if (filters.from) search.set('from', filters.from);
  if (filters.to) search.set('to', filters.to);
  return search;
}

export function activeLogFilterCount(filters: LogFilters): number {
  return [filters.q, filters.category, filters.result, filters.from, filters.to].filter(Boolean).length;
}

/** Validates filters against the shared schema; returns a field->message map when invalid. */
export function validateLogFilters(filters: LogFilters): Record<string, string> {
  const parsed = logQuerySchema.safeParse({
    q: filters.q || undefined,
    category: filters.category ?? undefined,
    result: filters.result ?? undefined,
    from: filters.from || undefined,
    to: filters.to || undefined,
  });
  if (parsed.success) return {};
  const errors: Record<string, string> = {};
  for (const issue of parsed.error.issues) errors[String(issue.path[0] ?? 'form')] ??= issue.message;
  return errors;
}

/** Query string for one page. The same filters are sent with every cursor. */
export function logQueryString(filters: LogFilters, cursor: string | null): string {
  const search = logFiltersToSearch(filters);
  if (cursor) search.set('cursor', cursor);
  const text = search.toString();
  return text ? `?${text}` : '';
}

export function actorLabel(actor: LogItem['actor']): { name: string; detail: string | null } {
  if (actor.nama) return { name: actor.nama, detail: actor.nip };
  if (actor.nip) return { name: actor.nip, detail: null };
  return { name: 'Sistem', detail: null };
}

/** Action-code prefixes per category. Keep in sync with LOG_CATEGORY_PREFIXES in server/services/administrasi.ts. */
const CATEGORY_PREFIXES: Record<LogCategory, readonly string[]> = {
  auth: ['LOGIN', 'LOGOUT', 'PASSWORD', 'SESSION', 'ACCOUNT'],
  pegawai: ['PEGAWAI', 'PROFILE', 'FOTO'],
  dokumen: ['DOKUMEN'],
  pengajuan: ['PENGAJUAN'],
  sistem: ['CONFIG', 'WA', 'BACKUP', 'REF', 'JENIS'],
  integrasi: ['API', 'APIKEY'],
};

/** Readable names for the audit action codes the server writes; the raw code stays available as a title. */
const ACTION_LABELS: Record<string, string> = {
  LOGIN: 'Masuk',
  LOGOUT: 'Keluar',
  LOGIN_FAILED: 'Gagal masuk',
  LOGIN_RATE_LIMITED: 'Percobaan masuk dibatasi',
  ACCOUNT_LOCKED: 'Akun terkunci',
  ACCOUNT_UNLOCK: 'Buka kunci akun',
  PASSWORD_CHANGE: 'Ganti password',
  PASSWORD_RESET: 'Reset password',
  SESSION_REVOKE: 'Keluarkan sesi',
  SESSION_REVOKE_OTHERS: 'Keluarkan sesi lain',
  PEGAWAI_CREATE: 'Tambah pegawai',
  PEGAWAI_UPDATE: 'Ubah data pegawai',
  PEGAWAI_DEACTIVATE: 'Nonaktifkan akun',
  PEGAWAI_REACTIVATE: 'Aktifkan akun',
  PEGAWAI_DELETE: 'Hapus pegawai',
  PEGAWAI_RESTORE: 'Pulihkan pegawai',
  PROFILE_UPDATE: 'Ubah profil',
  FOTO_PROFIL_UPLOAD: 'Unggah foto profil',
  DOKUMEN_UPLOAD: 'Unggah dokumen',
  DOKUMEN_REUPLOAD: 'Unggah ulang dokumen',
  DOKUMEN_APPROVE: 'Setujui dokumen',
  DOKUMEN_REJECT: 'Tolak dokumen',
  DOKUMEN_DELETE: 'Hapus dokumen',
  DOKUMEN_RESTORE: 'Pulihkan dokumen',
  DOKUMEN_ROLLBACK: 'Pulihkan versi dokumen',
  PENGAJUAN_CREATE: 'Ajukan perubahan data',
  PENGAJUAN_CANCEL: 'Batalkan pengajuan',
  PENGAJUAN_APPROVE: 'Setujui pengajuan',
  PENGAJUAN_REJECT: 'Tolak pengajuan',
  REF_CREATE: 'Tambah data referensi',
  REF_UPDATE: 'Ubah data referensi',
  JENIS_DOKUMEN_CREATE: 'Tambah jenis dokumen',
  JENIS_DOKUMEN_UPDATE: 'Ubah jenis dokumen',
  CONFIG_UPDATE: 'Ubah pengaturan',
  WA_TEST: 'Uji pesan WhatsApp',
  BACKUP_CREATE: 'Mulai backup',
  BACKUP_DONE: 'Backup selesai',
  BACKUP_FAILED: 'Backup gagal',
  APIKEY_CREATE: 'Buat kunci API',
  APIKEY_DELETE: 'Hapus kunci API',
  API_PEGAWAI_READ: 'Data pegawai dibaca lewat API',
  API_AUTH_FAILED: 'Kunci API ditolak',
  API_RATE_LIMITED: 'Permintaan API dibatasi',
};

/** Category of an action code ("PENGAJUAN_APPROVE" → pengajuan; also "dokumen.approve"). */
export function actionCategory(action: string): LogCategory | null {
  const head = action.split(/[._:]/)[0] ?? '';
  const upper = head.toUpperCase();
  for (const category of LOG_CATEGORIES) {
    if (CATEGORY_PREFIXES[category].includes(upper)) return category;
  }
  return pick(head, LOG_CATEGORIES);
}

/** "DOKUMEN_APPROVE" → "Setujui dokumen"; unknown codes → "Dokumen · approve"; anything else unchanged. */
export function actionLabel(action: string): string {
  const known = ACTION_LABELS[action];
  if (known) return known;
  const [, ...rest] = action.split(/[._:]/);
  const category = actionCategory(action);
  if (!category || rest.length === 0) return action;
  return `${CATEGORY_LABELS[category]} · ${rest.join(' ').toLowerCase()}`;
}
