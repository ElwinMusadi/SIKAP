import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  ChevronDown,
  CircleCheck,
  Clock,
  DatabaseBackup,
  Download,
  FileJson,
  Pause,
  Play,
  RefreshCw,
  ShieldAlert,
  TriangleAlert,
} from 'lucide-react';
import type { BackupJob, BackupListResponse, BackupStatus } from '@shared/backup';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { errorMessage, isApiError } from '@/lib/api';
import { formatDateTimeWITA } from '@/lib/format';
import { formatBytes, formatCountdown } from '@/features/dokumen/dokumen-utils';
import {
  BACKUP_STATUS_LABEL,
  MAX_STEP_ITERATIONS,
  backupErrorLabel,
  backupProgressPercent,
  findResumableJob,
  formatCount,
  isBackupExpired,
  manifestUrl,
  partUrl,
  runBackupLoop,
  upsertJob,
} from './backup-utils';
import { backupKeys, createBackupJob, fetchBackupList, stepBackupJob, useBackupList } from './queries';

type Phase = 'idle' | 'starting' | 'running' | 'pausing' | 'paused' | 'done' | 'failed' | 'limit' | 'error';

const PHASE_MESSAGE: Record<Phase, string> = {
  idle: '',
  starting: 'Menyiapkan backup…',
  running: 'Backup sedang berjalan. Biarkan halaman ini tetap terbuka.',
  pausing: 'Menjeda setelah bagian yang sedang diproses selesai…',
  paused: 'Backup dijeda. Lanjutkan kapan saja dari posisi terakhir.',
  done: 'Backup selesai. File dapat diunduh dari riwayat di bawah.',
  failed: 'Backup gagal.',
  limit: 'Backup dihentikan sementara karena batas langkah tercapai. Lanjutkan untuk meneruskan.',
  error: 'Backup terhenti karena kesalahan. Anda dapat melanjutkan dari posisi terakhir.',
};

const BUSY_PHASES: ReadonlySet<Phase> = new Set(['starting', 'running', 'pausing']);

export function BackupPanel() {
  const queryClient = useQueryClient();
  const list = useBackupList();

  const [phase, setPhase] = useState<Phase>('idle');
  const [activeJob, setActiveJob] = useState<BackupJob | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const controllerRef = useRef<AbortController | null>(null);
  const pauseRef = useRef(false);

  // Stop issuing step requests once the panel unmounts. An in-flight step may still commit
  // server-side; the next visit resumes from the server cursor.
  useEffect(() => () => controllerRef.current?.abort(), []);

  const syncJob = useCallback(
    (job: BackupJob) => {
      queryClient.setQueryData<BackupListResponse>(backupKeys.list(), (prev) =>
        prev ? { ...prev, jobs: upsertJob(prev.jobs, job) } : prev,
      );
    },
    [queryClient],
  );

  const busy = BUSY_PHASES.has(phase);
  const configured = list.data?.configured ?? false;
  const jobs = list.data?.jobs ?? [];
  const resumable = findResumableJob(jobs);

  const start = useCallback(async () => {
    if (controllerRef.current && !controllerRef.current.signal.aborted && BUSY_PHASES.has(phase)) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    const { signal } = controller;
    pauseRef.current = false;
    setRunError(null);
    setPhase('starting');

    let job: BackupJob | null = resumable;
    try {
      if (!job) {
        try {
          job = await createBackupJob(signal);
        } catch (error) {
          // Another unfinished job exists (e.g. started in another tab): resume it instead.
          if (!isApiError(error, 'CONFLICT')) throw error;
          const fresh = await fetchBackupList(signal);
          queryClient.setQueryData(backupKeys.list(), fresh);
          job = findResumableJob(fresh.jobs);
          if (!job) throw error;
        }
      }
      if (signal.aborted) return;
      syncJob(job);
      setActiveJob(job);
      setPhase((current) => (current === 'pausing' ? current : 'running'));

      const outcome = await runBackupLoop({
        initial: job,
        step: stepBackupJob,
        signal,
        shouldPause: () => pauseRef.current,
        onProgress: (next) => {
          setActiveJob(next);
          syncJob(next);
        },
      });
      if (signal.aborted || outcome.kind === 'aborted') return;

      setActiveJob(outcome.job);
      syncJob(outcome.job);
      setPhase(outcome.kind);
      if (outcome.kind === 'done' || outcome.kind === 'failed') {
        void queryClient.invalidateQueries({ queryKey: backupKeys.all });
      }
    } catch (error) {
      if (signal.aborted) return;
      setRunError(errorMessage(error));
      setPhase('error');
      void queryClient.invalidateQueries({ queryKey: backupKeys.all });
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }, [phase, queryClient, resumable, syncJob]);

  const pause = useCallback(() => {
    pauseRef.current = true;
    setPhase('pausing');
  }, []);

  // Prefer the live job while this panel drives it; otherwise show the server's unfinished job.
  const displayJob = activeJob && (busy || activeJob.status !== 'RUNNING' || activeJob.id === resumable?.id)
    ? activeJob
    : resumable;
  const showProgress = displayJob !== null && (busy || phase !== 'idle' || displayJob.status === 'RUNNING');
  const canResume = resumable !== null || (activeJob?.status === 'RUNNING' && !busy);
  const primaryLabel = canResume ? 'Lanjutkan backup' : 'Backup sekarang';

  return (
    <div className="flex flex-col gap-6">
      <Alert>
        <ShieldAlert aria-hidden="true" />
        <AlertTitle>Backup logis berisi data sensitif</AlertTitle>
        <AlertDescription>
          <ul className="list-disc space-y-1 pl-4">
            <li>
              Ekspor dibuat bertahap per tabel, sehingga <strong>bukan salinan pada satu titik waktu</strong> yang
              konsisten. Untuk pemulihan bencana gunakan D1 Time Travel atau <code>wrangler d1 export</code>.
            </li>
            <li>
              <strong>Isi file dokumen (R2) tidak ikut dicadangkan</strong>; yang tercatat hanya kunci objek dan
              checksum sebagai inventaris. Simpan backup file secara terpisah bila diperlukan.
            </li>
            <li>
              Berisi hash password dan token penyedia terenkripsi. Kunci <code>PASSWORD_PEPPER</code> dan{' '}
              <code>SETTINGS_ENC_KEY</code> tidak diekspor dan diperlukan terpisah untuk pemulihan.
            </li>
            <li>Unduhan hanya untuk admin. Simpan file di lokasi privat dan jangan dibagikan.</li>
          </ul>
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2 className="text-base font-medium">Buat backup</h2>
          </CardTitle>
          <CardDescription>
            Backup diproses per bagian selama halaman ini terbuka. Meninggalkan halaman akan menjeda proses; Anda dapat
            melanjutkannya nanti dari posisi terakhir. File tersimpan selama 30 hari.
          </CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-4">
          {list.isPending ? (
            <Skeleton className="h-16 w-full" />
          ) : list.isError ? null : !configured ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <DatabaseBackup aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>Penyimpanan backup belum dikonfigurasi</EmptyTitle>
                <EmptyDescription>
                  Hubungi pengelola sistem untuk menghubungkan penyimpanan backup sebelum membuat backup.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : showProgress && displayJob ? (
            <BackupProgress job={displayJob} phase={phase} />
          ) : (
            <p className="text-sm text-muted-foreground">Belum ada backup yang sedang berjalan.</p>
          )}

          <p aria-live="polite" role="status" className={phase === 'idle' ? 'sr-only' : 'text-sm text-muted-foreground'}>
            {PHASE_MESSAGE[phase]}
          </p>

          {phase === 'failed' && activeJob?.errorCode ? (
            <Alert variant="destructive">
              <TriangleAlert aria-hidden="true" />
              <AlertTitle>Backup gagal</AlertTitle>
              <AlertDescription>{backupErrorLabel(activeJob.errorCode)}</AlertDescription>
            </Alert>
          ) : null}
          {phase === 'error' && runError ? (
            <Alert variant="destructive">
              <TriangleAlert aria-hidden="true" />
              <AlertTitle>Backup terhenti</AlertTitle>
              <AlertDescription>{runError}</AlertDescription>
            </Alert>
          ) : null}
        </CardContent>

        <CardFooter className="flex flex-wrap gap-2">
          {busy ? (
            <Button variant="outline" onClick={pause} disabled={phase !== 'running'}>
              {phase === 'pausing' ? <Spinner data-icon="inline-start" /> : <Pause data-icon="inline-start" />}
              {phase === 'pausing' ? 'Menjeda…' : 'Jeda'}
            </Button>
          ) : (
            <Button onClick={() => void start()} disabled={!configured || list.isPending || list.isError}>
              {canResume ? <Play data-icon="inline-start" /> : <DatabaseBackup data-icon="inline-start" />}
              {primaryLabel}
            </Button>
          )}
          {busy && phase !== 'pausing' ? (
            <span className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner aria-hidden="true" /> Memproses…
            </span>
          ) : null}
        </CardFooter>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2 className="text-base font-medium">Riwayat backup</h2>
          </CardTitle>
          <CardDescription>20 backup terbaru yang belum kedaluwarsa.</CardDescription>
        </CardHeader>
        <CardContent>
          {list.isPending ? (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : list.isError ? (
            <Alert variant="destructive">
              <TriangleAlert aria-hidden="true" />
              <AlertTitle>Gagal memuat data backup</AlertTitle>
              <AlertDescription>
                <p>{errorMessage(list.error)}</p>
                <Button variant="outline" size="sm" onClick={() => void list.refetch()} disabled={list.isFetching}>
                  <RefreshCw data-icon="inline-start" />
                  Coba lagi
                </Button>
              </AlertDescription>
            </Alert>
          ) : jobs.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {configured ? 'Belum ada backup. Buat backup pertama dengan tombol di atas.' : 'Belum ada backup.'}
            </p>
          ) : (
            <BackupHistory jobs={jobs} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function BackupProgress({ job, phase }: { job: BackupJob; phase: Phase }) {
  const percent = backupProgressPercent(job);
  const stateLabel =
    job.status === 'RUNNING' && !BUSY_PHASES.has(phase) ? 'Dijeda' : BACKUP_STATUS_LABEL[job.status];
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium" id={`backup-progress-${job.id}`}>
          {formatCount(job.tablesCompleted)} dari {formatCount(job.totalTables)} tabel
        </span>
        <StatusBadge status={job.status} label={stateLabel} />
      </div>
      <Progress value={percent} aria-labelledby={`backup-progress-${job.id}`} />
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-muted-foreground">Tabel saat ini</dt>
          <dd className="truncate font-mono text-xs leading-5">{job.currentTable ?? '-'}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Baris</dt>
          <dd className="tabular-nums">{formatCount(job.rowCount)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Ukuran</dt>
          <dd className="tabular-nums">{formatBytes(job.byteCount)}</dd>
        </div>
      </dl>
      {phase === 'limit' ? (
        <p className="text-xs text-muted-foreground">
          Satu sesi dibatasi {formatCount(MAX_STEP_ITERATIONS)} langkah demi keamanan.
        </p>
      ) : null}
    </div>
  );
}

const STATUS_ICON: Record<BackupStatus, typeof Clock> = {
  RUNNING: Clock,
  DONE: CircleCheck,
  FAILED: TriangleAlert,
};

function StatusBadge({ status, label }: { status: BackupStatus; label?: string }) {
  const Icon = STATUS_ICON[status];
  return (
    <Badge variant={status === 'FAILED' ? 'destructive' : status === 'DONE' ? 'secondary' : 'outline'}>
      <Icon data-icon="inline-start" aria-hidden="true" />
      {label ?? BACKUP_STATUS_LABEL[status]}
    </Badge>
  );
}

function BackupHistory({ jobs }: { jobs: readonly BackupJob[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Dimulai</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Tabel</TableHead>
          <TableHead className="text-right">Baris</TableHead>
          <TableHead className="text-right">Ukuran</TableHead>
          <TableHead>Kedaluwarsa</TableHead>
          <TableHead>
            <span className="sr-only">File</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {jobs.map((job) => {
          const open = expanded === job.id;
          const expired = isBackupExpired(job.purgeAfter);
          const panelId = `backup-files-${job.id}`;
          return (
            <Fragment key={job.id}>
              <TableRow>
                <TableCell>
                  <div className="flex flex-col">
                    <span>{formatDateTimeWITA(job.startedAt)}</span>
                    {job.startedBy?.nama ? (
                      <span className="text-xs text-muted-foreground">oleh {job.startedBy.nama}</span>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell>
                  <StatusBadge status={job.status} />
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatCount(job.tablesCompleted)}/{formatCount(job.totalTables)}
                </TableCell>
                <TableCell className="text-right tabular-nums">{formatCount(job.rowCount)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatBytes(job.byteCount)}</TableCell>
                <TableCell className="text-muted-foreground">
                  {expired ? 'Kedaluwarsa' : formatCountdown(job.purgeAfter)}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-expanded={open}
                    aria-controls={open ? panelId : undefined}
                    onClick={() => setExpanded(open ? null : job.id)}
                  >
                    File ({formatCount(job.parts.length)})
                    <ChevronDown
                      data-icon="inline-end"
                      aria-hidden="true"
                      className={open ? 'rotate-180 transition-transform' : 'transition-transform'}
                    />
                  </Button>
                </TableCell>
              </TableRow>
              {open ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={7} className="bg-muted/40 whitespace-normal">
                    <BackupFiles job={job} expired={expired} id={panelId} />
                  </TableCell>
                </TableRow>
              ) : null}
            </Fragment>
          );
        })}
      </TableBody>
    </Table>
  );
}

function BackupFiles({ job, expired, id }: { job: BackupJob; expired: boolean; id: string }) {
  const errorLabel = backupErrorLabel(job.errorCode);
  const manifest = manifestUrl(job.id);
  return (
    <div id={id} className="flex flex-col gap-3 py-1">
      {expired ? (
        <p className="text-sm text-muted-foreground">File backup ini sudah kedaluwarsa dan tidak dapat diunduh.</p>
      ) : null}
      {job.status === 'FAILED' && errorLabel ? <p className="text-sm text-destructive">{errorLabel}</p> : null}
      {job.status === 'RUNNING' ? (
        <p className="text-sm text-muted-foreground">
          Backup belum selesai; bagian di bawah belum lengkap dan manifest belum tersedia.
        </p>
      ) : null}
      {job.status === 'DONE' && !expired && manifest ? (
        <div>
          <Button variant="outline" size="sm" asChild>
            <a href={manifest} download>
              <FileJson data-icon="inline-start" aria-hidden="true" />
              Unduh manifest
            </a>
          </Button>
        </div>
      ) : null}
      {job.parts.length === 0 ? (
        <p className="text-sm text-muted-foreground">Belum ada bagian yang tersimpan.</p>
      ) : (
        <ul className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3" aria-label="Bagian backup">
          {job.parts.map((part) => {
            // Built from the job id and sequence; the server-provided downloadUrl is not trusted.
            const href = expired ? null : partUrl(job.id, part.sequence);
            const text = (
              <>
                <span className="font-mono text-xs">
                  #{part.sequence} {part.table}
                </span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {formatCount(part.rows)} baris · {formatBytes(part.bytes)}
                </span>
              </>
            );
            return (
              <li key={part.sequence}>
                {href ? (
                  <a
                    href={href}
                    download
                    className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    aria-label={`Unduh bagian ${part.sequence} tabel ${part.table}`}
                  >
                    <Download className="size-3.5 shrink-0" aria-hidden="true" />
                    {text}
                  </a>
                ) : (
                  <span className="flex items-center gap-2 px-2 py-1 opacity-60">{text}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default BackupPanel;
