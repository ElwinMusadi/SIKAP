// Single status registry (docs/RENCANA-REDESIGN-UIUX.md §5.1): every status shown in SIKAP maps to one
// label, one tone and one icon here, so the same word never changes colour or icon between screens.
// Red is reserved for failed/rejected states; "not yet uploaded"/inactive/cancelled are neutral.
import {
  CircleCheck,
  CircleDashed,
  CircleMinus,
  CircleX,
  Clock,
  RotateCcw,
  Undo2,
  type LucideIcon,
} from 'lucide-react';
import type { StatusAkun, StatusDokumen, StatusPengajuan } from '@shared/enums';
import type { Kelengkapan } from '@shared/pegawai';

export type StatusTone = 'verified' | 'pending' | 'rejected' | 'neutral';

export interface StatusSpec {
  label: string;
  tone: StatusTone;
  icon: LucideIcon;
}

/** Literal class names per tone (Tailwind only generates classes it can see in source). */
export const TONE_CLASSES: Record<StatusTone, { badge: string; soft: string; text: string; solid: string; bar: string }> = {
  verified: {
    badge: 'border-status-verified/25 bg-status-verified-muted text-status-verified',
    soft: 'bg-status-verified-muted text-status-verified',
    text: 'text-status-verified',
    solid: 'bg-status-verified',
    bar: '*:bg-status-verified',
  },
  pending: {
    badge: 'border-status-pending/25 bg-status-pending-muted text-status-pending',
    soft: 'bg-status-pending-muted text-status-pending',
    text: 'text-status-pending',
    solid: 'bg-status-pending',
    bar: '*:bg-status-pending',
  },
  rejected: {
    badge: 'border-status-rejected/25 bg-status-rejected-muted text-status-rejected',
    soft: 'bg-status-rejected-muted text-status-rejected',
    text: 'text-status-rejected',
    solid: 'bg-status-rejected',
    bar: '*:bg-status-rejected',
  },
  neutral: {
    badge: 'border-status-missing/25 bg-status-missing-muted text-status-missing',
    soft: 'bg-status-missing-muted text-status-missing',
    text: 'text-status-missing',
    solid: 'bg-status-missing',
    bar: '*:bg-status-missing',
  },
};

/** Document status as shown to users ("Belum diunggah" is a UI-only state: no row yet). */
export type DokumenStatus = StatusDokumen | 'Belum diunggah';
export type HasilStatus = 'Berhasil' | 'Gagal';
export type AktifStatus = 'Aktif' | 'Nonaktif';

export const STATUS_REGISTRY = {
  dokumen: {
    'Belum diunggah': { label: 'Belum diunggah', tone: 'neutral', icon: CircleDashed },
    Menunggu: { label: 'Menunggu', tone: 'pending', icon: Clock },
    Terverifikasi: { label: 'Terverifikasi', tone: 'verified', icon: CircleCheck },
    Ditolak: { label: 'Ditolak', tone: 'rejected', icon: CircleX },
  },
  pengajuan: {
    Menunggu: { label: 'Menunggu', tone: 'pending', icon: Clock },
    Disetujui: { label: 'Disetujui', tone: 'verified', icon: CircleCheck },
    Ditolak: { label: 'Ditolak', tone: 'rejected', icon: CircleX },
    Dibatalkan: { label: 'Dibatalkan', tone: 'neutral', icon: Undo2 },
  },
  akun: {
    Aktif: { label: 'Aktif', tone: 'verified', icon: CircleCheck },
    Nonaktif: { label: 'Nonaktif', tone: 'neutral', icon: CircleMinus },
  },
  kelengkapan: {
    Lengkap: { label: 'Lengkap', tone: 'verified', icon: CircleCheck },
    'Belum Lengkap': { label: 'Belum lengkap', tone: 'pending', icon: CircleDashed },
    'Perlu Revisi': { label: 'Perlu revisi', tone: 'pending', icon: RotateCcw },
  },
  hasil: {
    Berhasil: { label: 'Berhasil', tone: 'verified', icon: CircleCheck },
    Gagal: { label: 'Gagal', tone: 'rejected', icon: CircleX },
  },
  aktif: {
    Aktif: { label: 'Aktif', tone: 'verified', icon: CircleCheck },
    Nonaktif: { label: 'Nonaktif', tone: 'neutral', icon: CircleMinus },
  },
} as const satisfies {
  dokumen: Record<DokumenStatus, StatusSpec>;
  pengajuan: Record<StatusPengajuan, StatusSpec>;
  akun: Record<StatusAkun, StatusSpec>;
  kelengkapan: Record<Kelengkapan, StatusSpec>;
  hasil: Record<HasilStatus, StatusSpec>;
  aktif: Record<AktifStatus, StatusSpec>;
};

export type StatusDomain = keyof typeof STATUS_REGISTRY;
export type StatusValue<D extends StatusDomain> = keyof (typeof STATUS_REGISTRY)[D];

const UNKNOWN: StatusSpec = { label: '—', tone: 'neutral', icon: CircleDashed };

export function statusSpec<D extends StatusDomain>(domain: D, status: StatusValue<D>): StatusSpec {
  // The type already restricts `status`; the fallback only guards data drift from the API.
  return (STATUS_REGISTRY[domain] as Record<PropertyKey, StatusSpec>)[status as PropertyKey] ?? UNKNOWN;
}
