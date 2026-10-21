import { describe, expect, it, vi } from 'vitest';
import type { BackupJob } from '@shared/backup';
import {
  backupErrorLabel,
  backupProgressPercent,
  findResumableJob,
  isBackupExpired,
  isBackupJobId,
  manifestUrl,
  partUrl,
  runBackupLoop,
  safeDownloadUrl,
  upsertJob,
} from './backup-utils';

const UUID = '3f2b8c1e-9a4d-4e6b-8c2a-1d5e7f9a0b3c';

function job(overrides: Partial<BackupJob> = {}): BackupJob {
  return {
    id: 'job-1',
    status: 'RUNNING',
    startedAt: '2026-10-16T00:00:00.000Z',
    finishedAt: null,
    purgeAfter: '2026-11-15T00:00:00.000Z',
    startedBy: null,
    currentTable: 'pegawai',
    tablesCompleted: 0,
    totalTables: 13,
    rowCount: 0,
    byteCount: 0,
    errorCode: null,
    consistent: false,
    includesFileBytes: false,
    parts: [],
    ...overrides,
  };
}

describe('backupProgressPercent', () => {
  it('never reports 100 for an unfinished job', () => {
    expect(backupProgressPercent(job({ tablesCompleted: 13, totalTables: 13 }))).toBe(99);
    expect(backupProgressPercent(job({ status: 'FAILED', tablesCompleted: 13 }))).toBe(99);
  });
  it('reports 100 only for DONE and handles zero totals', () => {
    expect(backupProgressPercent(job({ status: 'DONE', tablesCompleted: 13 }))).toBe(100);
    expect(backupProgressPercent(job({ totalTables: 0 }))).toBe(0);
    expect(backupProgressPercent(job({ tablesCompleted: 4 }))).toBe(30);
  });
});

describe('helpers', () => {
  it('finds the newest running job', () => {
    const jobs = [job({ id: 'a', status: 'DONE' }), job({ id: 'b' }), job({ id: 'c' })];
    expect(findResumableJob(jobs)?.id).toBe('b');
    expect(findResumableJob([job({ status: 'FAILED' })])).toBeNull();
  });
  it('detects expiry and invalid dates', () => {
    const now = new Date('2026-10-16T00:00:00.000Z');
    expect(isBackupExpired('2026-10-17T00:00:00.000Z', now)).toBe(false);
    expect(isBackupExpired('2026-10-15T00:00:00.000Z', now)).toBe(true);
    expect(isBackupExpired('invalid', now)).toBe(true);
  });
  it('builds part and manifest URLs only from a UUID and positive integer sequence', () => {
    expect(partUrl(UUID, 1)).toBe(`/api/admin/backup/${UUID}/parts/1`);
    expect(partUrl(UUID, 42)).toBe(`/api/admin/backup/${UUID}/parts/42`);
    expect(manifestUrl(UUID)).toBe(`/api/admin/backup/${UUID}/manifest`);
    for (const seq of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1e12]) {
      expect(partUrl(UUID, seq)).toBeNull();
    }
    for (const id of ['job-1', '', '../x', `${UUID}/../../evil`, '//evil.example', `${UUID}%2f`, ` ${UUID}`]) {
      expect(partUrl(id, 1)).toBeNull();
      expect(manifestUrl(id)).toBeNull();
    }
    expect(isBackupJobId(UUID.toUpperCase())).toBe(true);
  });

  it('accepts only exact same-origin backup download endpoints', () => {
    expect(safeDownloadUrl(`/api/admin/backup/${UUID}/parts/3`)).toBe(`/api/admin/backup/${UUID}/parts/3`);
    expect(safeDownloadUrl(`/api/admin/backup/${UUID}/manifest`)).toBe(`/api/admin/backup/${UUID}/manifest`);
  });

  it.each([
    // control characters stripped by browsers
    '/\t/evil.example/x',
    '/\n/evil.example/x',
    '/\r/evil.example/x',
    `/api/admin/backup/${UUID}/parts/1\t`,
    `\u0000/api/admin/backup/${UUID}/parts/1`,
    // backslashes treated as slashes
    '/\\evil.example/x',
    '\\\\evil.example/x',
    `/api\\admin/backup/${UUID}/parts/1`,
    // network-relative and external
    '//evil.example/x',
    '///evil.example/x',
    'https://evil.example/api/admin/backup/x',
    'http://localhost/api/admin/backup/x',
    'javascript:alert(1)',
    'data:text/html,hi',
    // encoded tricks
    '/%2f%2fevil.example/x',
    '/%2F%2Fevil.example/x',
    `/api/admin/backup/${UUID}%2fparts%2f1`,
    `/api/admin/backup/%2e%2e/%2e%2e/evil`,
    `/api/admin/backup/${UUID}/parts/%31`,
    '/%5cevil.example',
    // dot segments / normalisation
    `/api/admin/backup/../../evil`,
    `/api/admin/backup/${UUID}/parts/../manifest`,
    `/api/admin/backup/./${UUID}/manifest`,
    // wrong route or shape
    '/api/admin/backupx/x',
    '/api/admin/settings/whatsapp',
    `/api/admin/backup/${UUID}`,
    `/api/admin/backup/${UUID}/step`,
    `/api/admin/backup/${UUID}/parts/0`,
    `/api/admin/backup/${UUID}/parts/1/extra`,
    `/api/admin/backup/not-a-uuid/parts/1`,
    `/api/admin/backup/${UUID}/parts/1?redirect=//evil`,
    `/api/admin/backup/${UUID}/parts/1#x`,
    '',
    'api/admin/backup/x',
  ])('rejects %j', (url) => {
    expect(safeDownloadUrl(url)).toBeNull();
  });
  it('upserts jobs by id', () => {
    const list = [job({ id: 'a' }), job({ id: 'b' })];
    expect(upsertJob(list, job({ id: 'b', status: 'DONE' })).map((j) => [j.id, j.status])).toEqual([
      ['a', 'RUNNING'],
      ['b', 'DONE'],
    ]);
    expect(upsertJob(list, job({ id: 'c' }))[0]?.id).toBe('c');
  });
  it('labels error codes without raw text', () => {
    expect(backupErrorLabel(null)).toBeNull();
    expect(backupErrorLabel('BACKUP_SIZE_LIMIT')).toContain('50 MB');
    expect(backupErrorLabel('X')).toContain('X');
  });
});

describe('runBackupLoop', () => {
  it('steps sequentially until DONE', async () => {
    let n = 0;
    const step = vi.fn(async () => {
      n += 1;
      return job({ tablesCompleted: n, status: n === 3 ? 'DONE' : 'RUNNING' });
    });
    const onProgress = vi.fn();
    const result = await runBackupLoop({
      initial: job(),
      step,
      signal: new AbortController().signal,
      shouldPause: () => false,
      onProgress,
    });
    expect(result.kind).toBe('done');
    expect(step).toHaveBeenCalledTimes(3);
    expect(onProgress).toHaveBeenCalledTimes(3);
  });

  it('returns failed without further steps', async () => {
    const step = vi.fn(async () => job({ status: 'FAILED', errorCode: 'BACKUP_SIZE_LIMIT' }));
    const result = await runBackupLoop({ initial: job(), step, signal: new AbortController().signal, shouldPause: () => false });
    expect(result.kind).toBe('failed');
    expect(step).toHaveBeenCalledTimes(1);
  });

  it('does not step a finished initial job', async () => {
    const step = vi.fn();
    const result = await runBackupLoop({ initial: job({ status: 'DONE' }), step, signal: new AbortController().signal, shouldPause: () => false });
    expect(result.kind).toBe('done');
    expect(step).not.toHaveBeenCalled();
  });

  it('pauses before starting the next step', async () => {
    let pause = false;
    const step = vi.fn(async () => {
      pause = true;
      return job({ tablesCompleted: 1 });
    });
    const result = await runBackupLoop({ initial: job(), step, signal: new AbortController().signal, shouldPause: () => pause });
    expect(result).toMatchObject({ kind: 'paused', job: { tablesCompleted: 1, status: 'RUNNING' } });
    expect(step).toHaveBeenCalledTimes(1);
  });

  it('stops issuing requests after abort, even if the in-flight step resolves', async () => {
    const controller = new AbortController();
    const onProgress = vi.fn();
    const step = vi.fn(async () => {
      controller.abort();
      return job({ tablesCompleted: 1 });
    });
    const result = await runBackupLoop({ initial: job(), step, signal: controller.signal, shouldPause: () => false, onProgress });
    expect(result.kind).toBe('aborted');
    expect(step).toHaveBeenCalledTimes(1);
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('maps a rejected in-flight step to aborted when the signal aborted', async () => {
    const controller = new AbortController();
    const step = vi.fn(async () => {
      controller.abort();
      throw new DOMException('Aborted', 'AbortError');
    });
    const result = await runBackupLoop({ initial: job(), step, signal: controller.signal, shouldPause: () => false });
    expect(result.kind).toBe('aborted');
  });

  it('rethrows step errors when not aborted', async () => {
    const step = vi.fn(async () => {
      throw new Error('boom');
    });
    await expect(
      runBackupLoop({ initial: job(), step, signal: new AbortController().signal, shouldPause: () => false }),
    ).rejects.toThrow('boom');
  });

  it('honours the iteration cap', async () => {
    const step = vi.fn(async () => job());
    const result = await runBackupLoop({
      initial: job(),
      step,
      signal: new AbortController().signal,
      shouldPause: () => false,
      maxIterations: 5,
    });
    expect(result.kind).toBe('limit');
    expect(step).toHaveBeenCalledTimes(5);
  });
});
