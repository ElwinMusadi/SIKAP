// Pure helpers for Pengaturan Sistem → Integrasi API (contract: shared/integrasi.ts).
import { MASA_BERLAKU_HARI, type MasaBerlakuHari } from '@shared/integrasi';
import type { KunciApiStatus } from '@/lib/status';

const DAY_MS = 86_400_000;
/** A key within this many days of expiry is flagged so the admin can rotate it in time. */
export const SEGERA_KEDALUWARSA_HARI = 30;

/** Whole days left until `expiresAt` (rounded up; 0 once expired). */
export function sisaHari(expiresAt: string, nowMs: number): number {
  const ms = Date.parse(expiresAt) - nowMs;
  return Number.isFinite(ms) && ms > 0 ? Math.ceil(ms / DAY_MS) : 0;
}

export function kunciStatus(expiresAt: string, nowMs: number): KunciApiStatus {
  const ms = Date.parse(expiresAt) - nowMs;
  if (!Number.isFinite(ms) || ms <= 0) return 'Kedaluwarsa';
  return ms <= SEGERA_KEDALUWARSA_HARI * DAY_MS ? 'Segera kedaluwarsa' : 'Aktif';
}

/** "skp_ab12cd34ef56…": enough to match a key with a configuration, never the secret. */
export function kunciLabel(idPublik: string): string {
  return `skp_${idPublik}…`;
}

export function masaBerlakuLabel(hari: MasaBerlakuHari): string {
  return hari === 365 ? '1 tahun (365 hari)' : `${hari} hari`;
}

export const MASA_BERLAKU_OPTIONS = MASA_BERLAKU_HARI.map((hari) => ({ value: String(hari), label: masaBerlakuLabel(hari) }));

/** Base URL integration clients call, e.g. https://sikap.uptdpenda-kupang.web.id/api/v1 */
export function apiBaseUrl(origin: string): string {
  return `${origin.replace(/\/+$/, '')}/api/v1`;
}
