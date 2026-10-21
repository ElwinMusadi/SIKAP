import type { KepegawaianField, KepegawaianValue, RefResponse } from '@shared/profile';
import { formatDateWITA } from '@/lib/format';

export const EMPTY_VALUE = '—';

const DATE_FIELDS = new Set<KepegawaianField>(['tmtPangkat', 'tmtJabatan']);

/** 'YYYY-MM-DD' → "16 Oktober 2026" without timezone shifts (noon UTC stays on the same WITA day). */
export function formatIsoDate(value: string | null | undefined): string {
  if (!value) return EMPTY_VALUE;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return formatDateWITA(`${value}T12:00:00Z`);
}

/** Human-readable value of an employment field (pangkat/unit names from ref, dates formatted). */
export function formatKepegawaianValue(
  field: KepegawaianField,
  value: KepegawaianValue | undefined,
  ref: RefResponse | undefined,
): string {
  if (value === null || value === undefined || value === '') return EMPTY_VALUE;
  if (DATE_FIELDS.has(field)) return formatIsoDate(String(value));
  if (field === 'pangkatKode') {
    return ref?.pangkat.find((p) => p.kode === value)?.nama ?? String(value);
  }
  if (field === 'unitId') {
    const id = Number(value);
    return ref?.unit.find((u) => u.id === id)?.nama ?? `Unit #${value}`;
  }
  return String(value);
}

/** '6281234567890' → '0812-3456-7890'. Unknown formats are returned unchanged. */
export function formatPhone(value: string | null | undefined): string {
  if (!value) return EMPTY_VALUE;
  const digits = value.replace(/\D/g, '');
  if (!digits.startsWith('62') || digits.length < 9) return value;
  const local = `0${digits.slice(2)}`;
  const groups = [local.slice(0, 4), local.slice(4, 8), local.slice(8)].filter(Boolean);
  return groups.join('-');
}

/** Phone in the editable form: national format without separators ('081234567890'). */
export function phoneForInput(value: string | null | undefined): string {
  if (!value) return '';
  return value.startsWith('62') ? `0${value.slice(2)}` : value;
}

export { fromIsoDate, toIsoDate } from '@/lib/iso-date';
