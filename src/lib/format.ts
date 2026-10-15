import { formatDistanceToNow } from 'date-fns';
import { id as localeId } from 'date-fns/locale/id';

/** All dates are stored in UTC and shown in WITA (UTC+8). */
export const APP_TIME_ZONE = 'Asia/Makassar';

const dateTimeFormatter = new Intl.DateTimeFormat('id-ID', {
  timeZone: APP_TIME_ZONE,
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const dateFormatter = new Intl.DateTimeFormat('id-ID', {
  timeZone: APP_TIME_ZONE,
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

function toDate(value: string | number | Date): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "16 Okt 2026, 09.15 WITA" */
export function formatDateTimeWITA(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined) return '-';
  const date = toDate(value);
  return date ? `${dateTimeFormatter.format(date)} WITA` : '-';
}

/** "16 Oktober 2026" */
export function formatDateWITA(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined) return '-';
  const date = toDate(value);
  return date ? dateFormatter.format(date) : '-';
}

/** "5 menit yang lalu" */
export function formatRelative(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined) return '-';
  const date = toDate(value);
  return date ? formatDistanceToNow(date, { addSuffix: true, locale: localeId }) : '-';
}

/** Up to two initials, ignoring academic titles ("Dr.", "S.Kom") and punctuation. */
export function initials(nama: string | null | undefined): string {
  if (!nama) return '?';
  const name = nama.split(',')[0] ?? nama;
  const words = name
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}]/gu, ''))
    .filter((w, i, all) => w.length > 0 && !(all.length > 1 && i === 0 && /^(dr|drs|ir|hj|h|prof)$/i.test(w)));
  if (words.length === 0) return '?';
  const first = words[0]!.charAt(0);
  const last = words.length > 1 ? words[words.length - 1]!.charAt(0) : '';
  return (first + last).toUpperCase();
}
