import type { BackupJob, BackupStatus } from '@shared/backup';

/** Hard safety cap for one user-initiated run; the server also caps jobs at 500 parts. */
export const MAX_STEP_ITERATIONS = 500;

export const BACKUP_STATUS_LABEL: Record<BackupStatus, string> = {
  RUNNING: 'Belum selesai',
  DONE: 'Selesai',
  FAILED: 'Gagal',
};

const ERROR_CODE_LABEL: Record<string, string> = {
  BACKUP_SIZE_LIMIT: 'Backup melebihi batas ukuran (50 MB atau 500 bagian).',
  BACKUP_METADATA_ERROR: 'Metadata kemajuan backup tidak valid. Buat backup baru; ekspor ini tidak dinyatakan selesai.',
  BACKUP_STORAGE_ERROR: 'File backup gagal disimpan. Periksa penyimpanan backup lalu buat pekerjaan baru.',
  BACKUP_ROW_LIMIT: 'Satu baris terlalu besar untuk diekspor dengan aman pada batas Free plan.',
};

/** Controlled, user-facing description of a job error code. */
export function backupErrorLabel(code: string | null): string | null {
  if (!code) return null;
  return ERROR_CODE_LABEL[code] ?? `Backup berhenti dengan kode ${code}.`;
}

/** 0..100. Only a DONE job reports 100, so a running job never looks complete. */
export function backupProgressPercent(job: Pick<BackupJob, 'status' | 'tablesCompleted' | 'totalTables'>): number {
  if (job.status === 'DONE') return 100;
  if (job.totalTables <= 0) return 0;
  const percent = Math.floor((job.tablesCompleted / job.totalTables) * 100);
  return Math.min(99, Math.max(0, percent));
}

/** Newest unfinished job, which the next "Backup sekarang" resumes instead of creating a new one. */
export function findResumableJob(jobs: readonly BackupJob[]): BackupJob | null {
  return jobs.find((job) => job.status === 'RUNNING') ?? null;
}

export function isBackupExpired(purgeAfter: string, now: Date = new Date()): boolean {
  const time = new Date(purgeAfter).getTime();
  return Number.isNaN(time) || time <= now.getTime();
}

const countFormatter = new Intl.NumberFormat('id-ID');

export function formatCount(value: number): string {
  return countFormatter.format(value);
}

const BACKUP_PATH_PREFIX = '/api/admin/backup/';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Exact structured download endpoints; no percent-encoding, dot segments or extra segments. */
const DOWNLOAD_PATH_RE =
  /^\/api\/admin\/backup\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(?:parts\/[1-9][0-9]{0,8}|manifest)$/i;
// eslint-disable-next-line no-control-regex -- intentionally matches C0 controls, DEL and C1 controls.
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;
/** Fixed, non-routable base so parsing never depends on (or leaks to) the current location. */
const PARSE_BASE = 'https://sikap.invalid';

export function isBackupJobId(jobId: string): boolean {
  return UUID_RE.test(jobId);
}

function isPartSequence(sequence: number): boolean {
  return Number.isSafeInteger(sequence) && sequence >= 1 && sequence <= 999_999_999;
}

/** Same-origin manifest path built from a validated job UUID; null when the id is malformed. */
export function manifestUrl(jobId: string): string | null {
  return isBackupJobId(jobId) ? `${BACKUP_PATH_PREFIX}${encodeURIComponent(jobId)}/manifest` : null;
}

/**
 * Same-origin part path built client-side from the job UUID and part sequence. The server's
 * `downloadUrl` is intentionally not trusted. Null when either input is malformed.
 */
export function partUrl(jobId: string, sequence: number): string | null {
  if (!isBackupJobId(jobId) || !isPartSequence(sequence)) return null;
  return `${BACKUP_PATH_PREFIX}${encodeURIComponent(jobId)}/parts/${sequence}`;
}

/**
 * Defensive validator for an arbitrary download path. Accepts only an exact backup part/manifest
 * endpoint on the same origin and returns its normalised pathname; everything else returns null.
 */
export function safeDownloadUrl(url: string): string | null {
  if (typeof url !== 'string' || url.length === 0 || url.length > 512) return null;
  // Browsers strip tab/newline and treat backslashes as slashes, which can turn "/\t/host" or
  // "/\\host" into a network-relative URL. Reject them before parsing.
  if (CONTROL_RE.test(url) || url.includes('\\')) return null;
  if (!url.startsWith('/') || url.startsWith('//')) return null;
  // Any percent-encoding is unnecessary for UUID/integer endpoints and could hide "/" or ".".
  if (url.includes('%')) return null;

  let parsed: URL;
  try {
    parsed = new URL(url, PARSE_BASE);
  } catch {
    return null;
  }
  if (parsed.origin !== PARSE_BASE) return null;
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  if (parsed.pathname !== url) return null; // no dot-segment or other normalisation happened
  if (!parsed.pathname.startsWith(BACKUP_PATH_PREFIX) || !DOWNLOAD_PATH_RE.test(parsed.pathname)) return null;
  return parsed.pathname;
}

/** Replaces a job in a list by id (or prepends it), keeping newest-first order for new jobs. */
export function upsertJob(jobs: readonly BackupJob[], next: BackupJob): BackupJob[] {
  const index = jobs.findIndex((job) => job.id === next.id);
  if (index === -1) return [next, ...jobs];
  const copy = jobs.slice();
  copy[index] = next;
  return copy;
}

export type BackupRunOutcome =
  | { kind: 'done'; job: BackupJob }
  | { kind: 'failed'; job: BackupJob }
  /** User pressed "Jeda": no further step was started. The server job stays RUNNING. */
  | { kind: 'paused'; job: BackupJob }
  /** Component unmounted or the run was cancelled locally. */
  | { kind: 'aborted'; job: BackupJob }
  /** Safety cap reached while the job is still RUNNING. */
  | { kind: 'limit'; job: BackupJob };

export interface RunBackupLoopOptions {
  initial: BackupJob;
  step: (jobId: string, signal: AbortSignal) => Promise<BackupJob>;
  signal: AbortSignal;
  /** Checked before every step; returning true stops the loop without starting another step. */
  shouldPause: () => boolean;
  onProgress?: (job: BackupJob) => void;
  maxIterations?: number;
}

function terminal(job: BackupJob): BackupRunOutcome | null {
  if (job.status === 'DONE') return { kind: 'done', job };
  if (job.status === 'FAILED') return { kind: 'failed', job };
  return null;
}

/**
 * Sequentially awaits one bounded step at a time until the job is DONE/FAILED.
 * Never runs steps concurrently and never starts a step after abort or pause.
 * Non-abort step errors are rethrown; the last known job stays resumable from its server cursor.
 */
export async function runBackupLoop(options: RunBackupLoopOptions): Promise<BackupRunOutcome> {
  const { step, signal, shouldPause, onProgress, maxIterations = MAX_STEP_ITERATIONS } = options;
  let job = options.initial;

  for (let i = 0; i < maxIterations; i += 1) {
    const finished = terminal(job);
    if (finished) return finished;
    if (signal.aborted) return { kind: 'aborted', job };
    if (shouldPause()) return { kind: 'paused', job };

    try {
      job = await step(job.id, signal);
    } catch (error) {
      if (signal.aborted) return { kind: 'aborted', job };
      throw error;
    }
    if (signal.aborted) return { kind: 'aborted', job };
    onProgress?.(job);
  }

  return terminal(job) ?? { kind: 'limit', job };
}
