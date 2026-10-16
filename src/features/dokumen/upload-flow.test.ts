import { describe, expect, it } from 'vitest';
import type { DokumenItem, DokumenItemResponse } from '@shared/dokumen';
import { abortError, buildUploadHeaders, runUpload, sha256Hex, type UploadCallbacks, type UploadPhase } from './upload-flow';

const item = { jenisDokumenId: 'DOC-KTP' } as DokumenItem;

function harness(send: (cb: UploadCallbacks) => Promise<DokumenItemResponse>) {
  const phases: UploadPhase[] = [];
  const progress: number[] = [];
  const run = runUpload({ send, onPhase: (p) => phases.push(p), onProgress: (p) => progress.push(p) });
  return { run, phases, progress };
}

describe('sha256Hex', () => {
  it('returns the lowercase hex digest', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('buildUploadHeaders', () => {
  it('encodes the file name and falls back to octet-stream', () => {
    expect(buildUploadHeaders({ name: 'KTP Ani (1).pdf', type: '' }, 'ab')).toEqual({
      'Content-Type': 'application/octet-stream',
      'X-File-Name': 'KTP%20Ani%20(1).pdf',
      'X-Content-SHA256': 'ab',
    });
  });
});

describe('runUpload', () => {
  it('walks hashing → uploading → processing → done and resolves with the item', async () => {
    const { run, phases, progress } = harness(async ({ onStage, onProgress }) => {
      onStage('hashing');
      onStage('uploading');
      onProgress(40);
      onProgress(100);
      return { item };
    });
    await expect(run).resolves.toEqual({ status: 'success', item });
    expect(phases).toEqual(['hashing', 'uploading', 'processing', 'done']);
    expect(progress).toEqual([40, 100]);
  });

  it('reports aborts separately from errors', async () => {
    const aborted = harness(async () => {
      throw abortError();
    });
    await expect(aborted.run).resolves.toEqual({ status: 'aborted' });
    expect(aborted.phases).toEqual(['aborted']);

    const failure = new Error('boom');
    const failed = harness(async () => {
      throw failure;
    });
    await expect(failed.run).resolves.toEqual({ status: 'error', error: failure });
    expect(failed.phases).toEqual(['error']);
  });
});
