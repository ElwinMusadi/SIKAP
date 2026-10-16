import { describe, expect, it } from 'vitest';
import type { VerifikasiItem, VerifikasiQueueResponse } from '@shared/verifikasi';
import { appendReason, flattenQueue, neighborId, removeQueueItem, shortcutAction, type QueueData, type ShortcutEventLike } from './verifikasi-utils';

function item(arsipId: number): VerifikasiItem {
  return {
    arsipId,
    versi: 1,
    jenisDokumen: { id: 'DOC-KTP', nama: 'KTP', kategori: 'Identitas', wajib: true },
    pegawai: { id: 10, nama: 'Pegawai', nip: '123456', statusKepegawaian: 'PNS', jabatan: null, unit: null, fotoUrl: null },
    file: { fileName: 'ktp.pdf', mimeType: 'application/pdf', sizeBytes: 1024 },
    uploadedAt: '2026-10-16T00:00:00Z',
    isReupload: false,
    catatanSebelumnya: null,
  };
}

const page = (items: VerifikasiItem[], nextCursor: string | null): VerifikasiQueueResponse => ({
  items, nextCursor, total: 4, perJenis: { 'DOC-KTP': 3, 'DOC-SK': 1 },
});

const key = (key: string, overrides: Partial<ShortcutEventLike> = {}): ShortcutEventLike => ({
  key, ctrlKey: false, metaKey: false, altKey: false, defaultPrevented: false, target: { tagName: 'BUTTON' }, ...overrides,
});

describe('verification queue cache', () => {
  it('removes the decided item from every page without mutating the cache or cursors', () => {
    const data: QueueData = { pages: [page([item(1), item(2)], 'cursor'), page([item(3)], null)], pageParams: [null, 'cursor'] };
    const result = removeQueueItem(data, { arsipId: 2, jenisId: 'DOC-KTP', sisaAntrean: 3 });
    expect(flattenQueue(result).map((row) => row.arsipId)).toEqual([1, 3]);
    expect(result.pages.every((p) => p.total === 3 && p.perJenis['DOC-KTP'] === 2 && p.perJenis['DOC-SK'] === 1)).toBe(true);
    expect(data.pages[0]!.items).toHaveLength(2);
    expect(data.pages[0]!.perJenis['DOC-KTP']).toBe(3);
    expect(result.pageParams).toBe(data.pageParams);
    expect(result.pages[0]!.nextCursor).toBe('cursor');
  });

  it('updates counts even in another filtered cache and clamps counts at zero', () => {
    const data: QueueData = { pages: [{ ...page([], null), perJenis: { 'DOC-KTP': 0 } }], pageParams: [null] };
    const result = removeQueueItem(data, { arsipId: 2, jenisId: 'DOC-KTP', sisaAntrean: 0 });
    expect(result.pages[0]!.perJenis['DOC-KTP']).toBe(0);
    expect(result.pages[0]!.total).toBe(0);
  });

  it('selects the next item, falling back to the previous and then no selection', () => {
    expect(neighborId([item(1), item(2), item(3)], 2)).toBe(3);
    expect(neighborId([item(1), item(2)], 2)).toBe(1);
    expect(neighborId([item(1)], 1)).toBeNull();
    expect(neighborId([item(1)], 9)).toBeNull();
    expect(flattenQueue(undefined)).toEqual([]);
  });
});

describe('verification keyboard shortcuts', () => {
  it.each([['A', 'approve'], ['r', 'reject'], ['j', 'next'], ['ArrowDown', 'next'], ['K', 'prev'], ['ArrowUp', 'prev']])('maps %s to %s', (pressed, action) => {
    expect(shortcutAction(key(pressed))).toBe(action);
  });

  it.each(['INPUT', 'TEXTAREA', 'SELECT'])('does not intercept keys in %s', (tagName) => {
    expect(shortcutAction(key('a', { target: { tagName } }))).toBeNull();
  });

  it('ignores dialogs, editable content, modifiers, blocked state and handled events', () => {
    expect(shortcutAction(key('a', { target: { closest: () => ({}) } }))).toBeNull();
    expect(shortcutAction(key('r', { target: { isContentEditable: true } }))).toBeNull();
    expect(shortcutAction(key('a', { ctrlKey: true }))).toBeNull();
    expect(shortcutAction(key('a', { metaKey: true }))).toBeNull();
    expect(shortcutAction(key('a', { altKey: true }))).toBeNull();
    expect(shortcutAction(key('a', { defaultPrevented: true }))).toBeNull();
    expect(shortcutAction(key('a'), { blocked: true })).toBeNull();
    expect(shortcutAction(key('Enter'))).toBeNull();
  });

  it('prevents repeated decisions but permits repeated navigation', () => {
    expect(shortcutAction(key('a', { repeat: true }))).toBeNull();
    expect(shortcutAction(key('r', { repeat: true }))).toBeNull();
    expect(shortcutAction(key('j', { repeat: true }))).toBe('next');
  });
});

describe('quick rejection reasons', () => {
  it('appends distinct reasons and respects the field limit', () => {
    expect(appendReason('', 'Buram')).toBe('Buram');
    expect(appendReason('Buram.', 'Kedaluwarsa')).toBe('Buram; Kedaluwarsa');
    expect(appendReason('Buram', 'buram')).toBe('Buram');
    expect(appendReason('x'.repeat(495), 'Kedaluwarsa')).toHaveLength(500);
  });
});
