import { DOCUMENT_POLICY, type DokumenItem, type RiwayatAksi } from '@shared/dokumen';
import type { ProgressCounts } from '@/lib/progress';

const ALLOWED_EXTENSIONS = ['pdf', 'jpg', 'jpeg', 'png', 'webp'];

/** "512 B", "1,5 KB", "5 MB" (Indonesian decimal comma). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded.toLocaleString('id-ID')} ${units[unit]}`;
}

/** Time left until a purge deadline: "2 hari lagi", "5 jam lagi", "kurang dari 1 jam lagi". Floors (never overstates). */
export function formatCountdown(iso: string, now: Date = new Date()): string {
  const ms = new Date(iso).getTime() - now.getTime();
  if (Number.isNaN(ms)) return '-';
  if (ms <= 0) return 'segera dihapus permanen';
  const hours = ms / 3_600_000;
  if (hours < 1) return 'kurang dari 1 jam lagi';
  if (hours < 24) return `${Math.floor(hours)} jam lagi`;
  return `${Math.floor(hours / 24)} hari lagi`;
}

export type FileKind = 'pdf' | 'image' | 'other';

export function fileKind(mime: string | null | undefined): FileKind {
  if (mime === 'application/pdf') return 'pdf';
  if (mime?.startsWith('image/')) return 'image';
  return 'other';
}

export function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** Client-side pre-check (UX only; the server verifies magic bytes). Returns an error message or null. */
export function validateFile(file: { name: string; size: number; type: string }, maxBytes: number): string | null {
  if (file.size === 0) return 'File kosong. Pilih file lain.';
  const ext = fileExtension(file.name);
  const extOk = ALLOWED_EXTENSIONS.includes(ext);
  const typeOk = (DOCUMENT_POLICY.mimeTypes as readonly string[]).includes(file.type);
  // A known MIME decides; with an empty MIME the extension decides; with no extension the MIME decides.
  const accepted = file.type !== '' ? typeOk && (ext === '' || extOk) : extOk;
  if (!accepted) return 'Format file tidak didukung. Gunakan PDF, JPG, PNG, atau WEBP.';
  if (file.size > maxBytes) return `Ukuran file melebihi batas ${formatBytes(maxBytes)}.`;
  return null;
}

export const RIWAYAT_LABEL: Record<RiwayatAksi, string> = {
  UPLOAD: 'Diunggah',
  REUPLOAD: 'Diunggah ulang',
  APPROVE: 'Disetujui',
  REJECT: 'Ditolak',
  DELETE: 'Dihapus',
  RESTORE: 'Dipulihkan',
  ROLLBACK: 'Versi dipulihkan',
};

export type PrimaryAction = 'restore' | 'upload' | 'view';

/** The single most relevant action for a row (shown as a visible button; the rest go in the menu). */
export function primaryAction(item: DokumenItem): PrimaryAction {
  if (!item.arsip && item.deleted && item.can.restore) return 'restore';
  if (item.status === 'Belum diunggah' || item.status === 'Ditolak' || !item.arsip) return 'upload';
  return 'view';
}

/**
 * `/dokumen?jenis=` target: upload when that is the next (allowed) step, otherwise the preview.
 * null when neither applies (nothing uploaded and uploading is blocked): the row explains why.
 */
export function deepLinkTarget(item: DokumenItem): 'upload' | 'preview' | null {
  const needsUpload = item.status === 'Belum diunggah' || item.status === 'Ditolak';
  if (item.can.upload && needsUpload) return 'upload';
  return item.arsip ? 'preview' : null;
}

export function uploadLabel(item: DokumenItem): string {
  return item.arsip ? 'Unggah Ulang' : 'Unggah';
}

/** Per-status counts of the mandatory documents (input of ProgressMeter). */
export function wajibCounts(items: readonly DokumenItem[]): ProgressCounts {
  const counts: ProgressCounts = { terverifikasi: 0, menunggu: 0, ditolak: 0, belum: 0 };
  for (const item of items) {
    if (!item.wajib) continue;
    if (item.status === 'Terverifikasi') counts.terverifikasi += 1;
    else if (item.status === 'Menunggu') counts.menunggu += 1;
    else if (item.status === 'Ditolak') counts.ditolak += 1;
    else counts.belum += 1;
  }
  return counts;
}

export type UploadedDokumen = DokumenItem & { arsip: NonNullable<DokumenItem['arsip']> };

/** Documents with an active file, newest upload first. */
export function recentUploads(items: readonly DokumenItem[], limit: number): UploadedDokumen[] {
  return items
    .filter((item): item is UploadedDokumen => item.arsip !== null)
    .sort((a, b) => b.arsip.uploadedAt.localeCompare(a.arsip.uploadedAt))
    .slice(0, limit);
}

/**
 * Choices for the page-level "Unggah dokumen" menu: documents that still need a file
 * (rejected first, then mandatory, then optional), followed by the ones that can be replaced.
 */
export function uploadChoices(items: readonly DokumenItem[]): { needed: DokumenItem[]; replace: DokumenItem[] } {
  const uploadable = items.filter((item) => item.can.upload);
  const rank = (item: DokumenItem) => (item.status === 'Ditolak' ? 0 : item.wajib ? 1 : 2);
  const needed = uploadable
    .filter((item) => item.status === 'Belum diunggah' || item.status === 'Ditolak')
    .sort((a, b) => rank(a) - rank(b));
  const replace = uploadable.filter((item) => item.status !== 'Belum diunggah' && item.status !== 'Ditolak');
  return { needed, replace };
}
