// Framework-free upload helpers (unit-tested in node): hashing, request headers, and the
// submit flow that drives the dialog's phase state.
import { UPLOAD_HEADERS, type DokumenItem, type DokumenItemResponse } from '@shared/dokumen';

/** Lowercase hex SHA-256, as required by the X-Content-SHA256 header. */
export async function sha256Hex(data: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function buildUploadHeaders(file: { name: string; type: string }, sha256: string): Record<string, string> {
  return {
    'Content-Type': file.type || 'application/octet-stream',
    [UPLOAD_HEADERS.fileName]: encodeURIComponent(file.name),
    [UPLOAD_HEADERS.sha256]: sha256,
  };
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export function abortError(): DOMException {
  return new DOMException('Aborted', 'AbortError');
}

/** 'hashing' → 'uploading' → 'processing' (bytes sent, server working) → 'done' | 'error' | 'aborted'. */
export type UploadPhase = 'idle' | 'hashing' | 'uploading' | 'processing' | 'done' | 'error' | 'aborted';
export type UploadStage = 'hashing' | 'uploading';

export const UPLOAD_PHASE_MESSAGE: Record<UploadPhase, string> = {
  idle: '',
  hashing: 'Menyiapkan file…',
  uploading: 'Mengunggah…',
  processing: 'Memproses file di server…',
  done: 'Selesai. Dokumen berhasil diunggah.',
  error: 'Unggahan gagal.',
  aborted: 'Unggahan dibatalkan.',
};

export function isUploadActive(phase: UploadPhase): boolean {
  return phase === 'hashing' || phase === 'uploading' || phase === 'processing';
}

export type UploadOutcome =
  | { status: 'success'; item: DokumenItem }
  | { status: 'aborted' }
  | { status: 'error'; error: unknown };

export interface UploadCallbacks {
  onStage: (stage: UploadStage) => void;
  onProgress: (percent: number) => void;
}

/**
 * Runs one upload. `send` is typically `mutateAsync`; awaiting it (instead of per-call mutate()
 * callbacks) keeps the outcome handling alive even if the caller re-renders with new props.
 */
export async function runUpload({
  send,
  onPhase,
  onProgress,
}: {
  send: (callbacks: UploadCallbacks) => Promise<DokumenItemResponse>;
  onPhase: (phase: UploadPhase) => void;
  onProgress: (percent: number) => void;
}): Promise<UploadOutcome> {
  try {
    const { item } = await send({
      onStage: onPhase,
      onProgress: (percent) => {
        onProgress(percent);
        if (percent >= 100) onPhase('processing');
      },
    });
    onPhase('done');
    return { status: 'success', item };
  } catch (error) {
    if (isAbortError(error)) {
      onPhase('aborted');
      return { status: 'aborted' };
    }
    onPhase('error');
    return { status: 'error', error };
  }
}
