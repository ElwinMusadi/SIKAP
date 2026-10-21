import { describe, expect, it } from 'vitest';
import type { DokumenItem } from '@shared/dokumen';
import { deepLinkTarget, formatBytes, formatCountdown, primaryAction, validateFile } from './dokumen-utils';

const MB = 1024 * 1024;

function item(overrides: Partial<DokumenItem> = {}): DokumenItem {
  return {
    jenisDokumenId: 'DOC-KTP',
    nama: 'KTP',
    kategori: 'Identitas',
    wajib: true,
    maxSizeBytes: 5 * MB,
    status: 'Belum diunggah',
    arsip: null,
    deleted: null,
    versiSebelumnya: [],
    can: { upload: true, delete: false, rollback: false, restore: false },
    uploadBlockedReason: null,
    ...overrides,
  };
}

const arsip: NonNullable<DokumenItem['arsip']> = {
  id: 7,
  versi: 1,
  fileName: 'ktp.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 1000,
  catatanAdmin: null,
  uploadedAt: '2026-10-01T00:00:00Z',
  verifiedAt: null,
  verifiedBy: null,
};

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [512, '512 B'],
    [1536, '1,5 KB'],
    [5 * MB, '5 MB'],
    [12.4 * MB, '12 MB'],
    [-1, '-'],
  ])('%d → %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });
});

describe('formatCountdown', () => {
  const now = new Date('2026-10-16T00:00:00Z');
  it.each([
    ['2026-10-18T12:00:00Z', '2 hari lagi'],
    ['2026-10-16T05:30:00Z', '5 jam lagi'],
    ['2026-10-16T00:20:00Z', 'kurang dari 1 jam lagi'],
    ['2026-10-15T00:00:00Z', 'segera dihapus permanen'],
    ['invalid', '-'],
  ])('%s → %s', (iso, expected) => {
    expect(formatCountdown(iso, now)).toBe(expected);
  });
});

describe('validateFile', () => {
  it('accepts allowed types within the limit', () => {
    expect(validateFile({ name: 'a.PDF', size: 10, type: 'application/pdf' }, MB)).toBeNull();
    expect(validateFile({ name: 'a.jpeg', size: 10, type: '' }, MB)).toBeNull();
    expect(validateFile({ name: 'scan', size: 10, type: 'image/png' }, MB)).toBeNull();
  });
  it('rejects files with neither a known extension nor a known type', () => {
    expect(validateFile({ name: 'scan', size: 10, type: '' }, MB)).toMatch(/tidak didukung/);
  });
  it('rejects empty, oversized and disallowed files', () => {
    expect(validateFile({ name: 'a.pdf', size: 0, type: 'application/pdf' }, MB)).toMatch(/kosong/);
    expect(validateFile({ name: 'a.pdf', size: 2 * MB, type: 'application/pdf' }, MB)).toMatch(/1 MB/);
    expect(validateFile({ name: 'a.docx', size: 10, type: 'application/msword' }, MB)).toMatch(/tidak didukung/);
    expect(validateFile({ name: 'a.pdf', size: 10, type: 'text/html' }, MB)).toMatch(/tidak didukung/);
  });
});

describe('deepLinkTarget / primaryAction', () => {
  it('opens upload for missing or rejected documents when allowed', () => {
    expect(deepLinkTarget(item())).toBe('upload');
    expect(deepLinkTarget(item({ status: 'Ditolak', arsip }))).toBe('upload');
  });
  it('opens the preview otherwise, or nothing when there is no file and upload is blocked', () => {
    expect(deepLinkTarget(item({ status: 'Menunggu', arsip, can: { upload: false, delete: true, rollback: true, restore: false } }))).toBe('preview');
    expect(deepLinkTarget(item({ can: { upload: false, delete: false, rollback: false, restore: false } }))).toBeNull();
  });
  it('prefers restoring a soft-deleted file', () => {
    const deleted = { id: 7, fileName: 'ktp.pdf', deletedAt: '2026-10-15T00:00:00Z', purgeAfter: '2026-10-18T00:00:00Z' };
    expect(primaryAction(item({ deleted, can: { upload: false, delete: false, rollback: false, restore: true } }))).toBe('restore');
    expect(primaryAction(item({ status: 'Terverifikasi', arsip }))).toBe('view');
  });
});
