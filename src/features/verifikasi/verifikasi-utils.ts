import type { InfiniteData } from '@tanstack/react-query';
import type { VerifikasiItem, VerifikasiQueueResponse } from '@shared/verifikasi';

export type QueueData = InfiniteData<VerifikasiQueueResponse>;

export function flattenQueue(data: QueueData | undefined): VerifikasiItem[] {
  return data?.pages.flatMap((page) => page.items) ?? [];
}

/**
 * Removes a decided item from every cached page and updates the counters.
 * `total` becomes the server's `sisaAntrean`; the item's jenis count drops by one
 * (also in caches filtered to another jenis, where the item itself is absent).
 */
export function removeQueueItem(
  data: QueueData,
  decided: { arsipId: number; jenisId: string; sisaAntrean: number },
): QueueData {
  return {
    ...data,
    pages: data.pages.map((page) => {
      const current = page.perJenis[decided.jenisId];
      return {
        ...page,
        items: page.items.filter((item) => item.arsipId !== decided.arsipId),
        total: Math.max(0, decided.sisaAntrean),
        perJenis:
          current === undefined ? page.perJenis : { ...page.perJenis, [decided.jenisId]: Math.max(0, current - 1) },
      };
    }),
  };
}

/** The item to select after `arsipId` leaves the queue: the next one, else the previous one. */
export function neighborId(items: readonly VerifikasiItem[], arsipId: number): number | null {
  const index = items.findIndex((item) => item.arsipId === arsipId);
  if (index < 0) return null;
  return items[index + 1]?.arsipId ?? items[index - 1]?.arsipId ?? null;
}

/** `?arsip=<id>` deep link (Beranda, detail pegawai) → arsip id, or null when absent/invalid. */
export function parseArsipParam(value: string | null): number | null {
  if (value === null || !/^\d{1,15}$/.test(value)) return null;
  const id = Number(value);
  return id > 0 ? id : null;
}

/** Queue items waiting at least this many days get the amber "lama menunggu" marker. */
export const WAIT_WARN_DAYS = 3;

/** Whole days since upload (0 for future or unparseable timestamps). */
export function waitingDays(uploadedAt: string, now = Date.now()): number {
  const t = Date.parse(uploadedAt);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((now - t) / 86_400_000));
}

/** Short waiting time for the narrow queue column: "baru saja", "12 mnt", "5 jam", "3 hari". */
export function compactWait(uploadedAt: string, now = Date.now()): string {
  const t = Date.parse(uploadedAt);
  if (Number.isNaN(t)) return '-';
  const minutes = Math.max(0, Math.floor((now - t) / 60_000));
  if (minutes < 1) return 'baru saja';
  if (minutes < 60) return `${minutes} mnt`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} jam` : `${Math.floor(hours / 24)} hari`;
}

/* ------------------------------------------------------------------ */
/* Keyboard shortcuts                                                  */
/* ------------------------------------------------------------------ */

export type ShortcutAction = 'approve' | 'reject' | 'next' | 'prev';

/** Structural subset of KeyboardEvent so the guard is testable without a DOM. */
export interface ShortcutEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  repeat?: boolean;
  defaultPrevented: boolean;
  target: unknown;
}

interface TargetLike {
  tagName?: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
}

const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
/** Widgets that own their arrow/letter keys (open Select lists, menus, dialogs, comboboxes). */
const KEY_OWNING_SELECTOR = '[role="listbox"],[role="menu"],[role="dialog"],[role="alertdialog"],[role="combobox"],[contenteditable="true"]';

export function isKeyOwningTarget(target: unknown): boolean {
  if (typeof target !== 'object' || target === null) return false;
  const t = target as TargetLike;
  if (t.tagName && EDITABLE_TAGS.has(t.tagName.toUpperCase())) return true;
  if (t.isContentEditable) return true;
  return typeof t.closest === 'function' && Boolean(t.closest(KEY_OWNING_SELECTOR));
}

const KEY_MAP: Record<string, ShortcutAction> = {
  a: 'approve',
  r: 'reject',
  j: 'next',
  arrowdown: 'next',
  k: 'prev',
  arrowup: 'prev',
};

/**
 * Decides whether a keydown should trigger a verification shortcut.
 * Never fires with modifiers (Ctrl+A etc.), inside inputs/widgets, while blocked
 * (dialog open, decision pending), or on auto-repeat for approve/reject.
 */
export function shortcutAction(event: ShortcutEventLike, options: { blocked?: boolean } = {}): ShortcutAction | null {
  if (options.blocked || event.defaultPrevented) return null;
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  const action = KEY_MAP[event.key.toLowerCase()];
  if (!action) return null;
  if (event.repeat && (action === 'approve' || action === 'reject')) return null;
  if (isKeyOwningTarget(event.target)) return null;
  return action;
}

export const REJECT_QUICK_REASONS = [
  'Dokumen tidak terbaca / buram',
  'Dokumen tidak sesuai jenis',
  'Dokumen sudah kedaluwarsa',
  'Data tidak sesuai profil',
] as const;

export const ALASAN_MAX = 500;

/** Appends a quick reason to the current text ("a; b"), capped at the max length. */
export function appendReason(current: string, reason: string, max = ALASAN_MAX): string {
  const base = current.trim();
  if (base.toLowerCase().includes(reason.toLowerCase())) return current;
  const next = base ? `${base.replace(/[;.,]\s*$/, '')}; ${reason}` : reason;
  return next.slice(0, max);
}
