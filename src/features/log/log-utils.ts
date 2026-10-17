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

/** "dokumen.approve" -> "Dokumen · approve" for readability; the raw code stays available as a title. */
export function actionLabel(action: string): string {
  const [prefix, ...rest] = action.split(/[._:]/);
  const category = pick(prefix ?? null, LOG_CATEGORIES);
  if (!category || rest.length === 0) return action;
  return `${CATEGORY_LABELS[category]} · ${rest.join(' ')}`;
}
