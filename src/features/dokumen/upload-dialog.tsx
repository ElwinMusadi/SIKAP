import { useEffect, useId, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { FileImage, FileText, Info, RefreshCw, TriangleAlert, Upload, UserRound } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { DOCUMENT_POLICY, type DokumenItem } from '@shared/dokumen';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldError } from '@/components/ui/field';
import { Progress } from '@/components/ui/progress';
import { Spinner } from '@/components/ui/spinner';
import { errorMessage, isApiError } from '@/lib/api';
import { formatDateTimeWITA } from '@/lib/format';
import { cn } from '@/lib/utils';
import { fileExtension, fileKind, formatBytes, validateFile } from './dokumen-utils';
import { dokumenKeys, useUploadDocument } from './queries';
import { UPLOAD_PHASE_MESSAGE, isUploadActive, runUpload, type UploadPhase } from './upload-flow';

interface UploadDialogProps {
  item: DokumenItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function UploadDialog({ item, open, onOpenChange }: UploadDialogProps) {
  const [busy, setBusy] = useState(false);

  const handleOpenChange = (next: boolean) => {
    // Closing unmounts the form, whose cleanup aborts any running upload.
    if (!next) setBusy(false);
    onOpenChange(next);
  };

  return (
    <Dialog open={open && item !== null} onOpenChange={handleOpenChange}>
      {item ? (
        <DialogContent
          className="sm:max-w-lg"
          // Avoid losing an upload in progress to a stray click/Escape; the Cancel button aborts explicitly.
          onInteractOutside={(event) => busy && event.preventDefault()}
          onEscapeKeyDown={(event) => busy && event.preventDefault()}
        >
          {/* Keyed by jenis only: the item's versi/status change when the upload succeeds and must not
              remount the form while its success handling is still running. */}
          <UploadForm
            key={item.jenisDokumenId}
            item={item}
            onBusyChange={setBusy}
            onDone={() => handleOpenChange(false)}
          />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

/** MIME used only for the local icon/thumbnail when the browser reports no type. */
function guessMime(file: File): string {
  if (file.type) return file.type;
  return fileExtension(file.name) === 'pdf' ? 'application/pdf' : 'image/*';
}

function UploadForm({
  item,
  onBusyChange,
  onDone,
}: {
  item: DokumenItem;
  onBusyChange: (busy: boolean) => void;
  onDone: () => void;
}) {
  const upload = useUploadDocument();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const dragDepth = useRef(0);
  const hintId = useId();
  const errorId = useId();

  const [file, setFile] = useState<File | null>(null);
  const [clientError, setClientError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<unknown>(null);
  const [dragging, setDragging] = useState(false);
  const [phase, setPhase] = useState<UploadPhase>('idle');
  const [progress, setProgress] = useState(0);
  const [reloading, setReloading] = useState(false);

  const active = isUploadActive(phase);
  const isReupload = item.arsip !== null;

  // Abort a running upload when the dialog closes/unmounts.
  useEffect(() => () => abortRef.current?.abort(), []);

  const pick = (selected: File | undefined) => {
    if (!selected || active) return;
    setFile(selected);
    setServerError(null);
    setPhase('idle');
    setClientError(validateFile(selected, item.maxSizeBytes));
  };

  const openPicker = () => {
    if (!active) inputRef.current?.click();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openPicker();
    }
  };

  const onDragEnter = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (active) return;
    dragDepth.current += 1;
    setDragging(true);
  };
  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = active ? 'none' : 'copy';
  };
  const onDragLeave = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    pick(event.dataTransfer.files[0]);
  };

  const submit = async () => {
    if (!file || clientError || active || !item.can.upload) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setServerError(null);
    setProgress(0);
    onBusyChange(true);
    try {
      const outcome = await runUpload({
        send: ({ onStage, onProgress }) =>
          upload.mutateAsync({ jenisId: item.jenisDokumenId, file, signal: controller.signal, onStage, onProgress }),
        onPhase: setPhase,
        onProgress: setProgress,
      });
      if (outcome.status === 'success') {
        toast.success('Dokumen berhasil diunggah dan menunggu verifikasi.');
        onDone();
      } else if (outcome.status === 'error') {
        setServerError(outcome.error);
      }
    } finally {
      abortRef.current = null;
      onBusyChange(false);
    }
  };

  const reload = async () => {
    setReloading(true);
    try {
      await queryClient.invalidateQueries({ queryKey: dokumenKeys.mine });
      setServerError(null);
      setPhase('idle');
    } finally {
      setReloading(false);
    }
  };

  const fields = isApiError(serverError) ? serverError.fields : undefined;
  const fileError = clientError ?? fields?.file ?? null;
  const profileMissing = fields?.profile;
  const otherError = serverError && !fields?.file && !profileMissing ? serverError : null;
  const isConflict = isApiError(otherError, 'CONFLICT');
  const maxLabel = formatBytes(item.maxSizeBytes);
  const kind = file ? fileKind(guessMime(file)) : null;
  const liveMessage =
    phase === 'error' && serverError ? `${UPLOAD_PHASE_MESSAGE.error} ${errorMessage(serverError)}` : UPLOAD_PHASE_MESSAGE[phase];

  return (
    <>
      <DialogHeader>
        <DialogTitle>Unggah {item.nama}</DialogTitle>
        <DialogDescription>
          {item.kategori}
          {item.wajib ? ' · Wajib' : ' · Opsional'}
        </DialogDescription>
      </DialogHeader>

      <div className="flex min-w-0 flex-col gap-4">
        {item.deleted ? (
          <Alert role="note">
            <Info />
            <AlertDescription>
              Dokumen yang dihapus akan disimpan sebagai versi sebelumnya dan tetap dapat dipulihkan sampai{' '}
              {formatDateTimeWITA(item.deleted.purgeAfter)}.
            </AlertDescription>
          </Alert>
        ) : isReupload ? (
          <Alert role="note">
            <Info />
            <AlertDescription>File sebelumnya disimpan selama 3 hari dan dapat dipulihkan.</AlertDescription>
          </Alert>
        ) : null}

        {item.status === 'Ditolak' && item.arsip?.catatanAdmin ? (
          <Alert variant="destructive" role="note">
            <TriangleAlert />
            <AlertTitle>Alasan penolakan</AlertTitle>
            <AlertDescription>{item.arsip.catatanAdmin}</AlertDescription>
          </Alert>
        ) : null}

        {!item.can.upload && !active && phase !== 'done' ? (
          <Alert role="note">
            <Info />
            <AlertTitle>Dokumen tidak dapat diunggah saat ini</AlertTitle>
            <AlertDescription>{item.uploadBlockedReason ?? 'Muat ulang halaman untuk melihat status terbaru.'}</AlertDescription>
          </Alert>
        ) : null}

        <Field data-invalid={fileError ? true : undefined}>
          <input
            ref={inputRef}
            type="file"
            accept={DOCUMENT_POLICY.accept}
            hidden
            tabIndex={-1}
            onChange={(event) => {
              pick(event.target.files?.[0]);
              event.target.value = '';
            }}
          />
          <div
            role="button"
            tabIndex={active ? -1 : 0}
            aria-disabled={active || undefined}
            aria-invalid={fileError ? true : undefined}
            aria-describedby={fileError ? `${hintId} ${errorId}` : hintId}
            aria-label={file ? 'Ganti file' : 'Pilih file untuk diunggah'}
            onClick={openPicker}
            onKeyDown={onKeyDown}
            onDragEnter={onDragEnter}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            className={cn(
              'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-4 py-6 text-center outline-none transition-colors',
              'hover:bg-muted/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
              dragging && 'border-primary bg-primary/5',
              fileError && 'border-destructive',
              active && 'pointer-events-none opacity-60',
              file && 'py-4',
            )}
          >
            <div className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <Upload aria-hidden="true" className="size-5" />
            </div>
            <p className="text-sm font-medium">
              {dragging ? 'Lepaskan file di sini' : file ? 'Seret file lain atau klik untuk mengganti' : 'Seret file ke sini atau klik untuk memilih'}
            </p>
            <p id={hintId} className="text-xs text-muted-foreground">
              PDF, JPG, PNG, atau WEBP · maks. {maxLabel}
            </p>
          </div>
          {fileError ? <FieldError id={errorId}>{fileError}</FieldError> : null}
        </Field>

        {file ? (
          <div className="flex items-center gap-3 rounded-lg border bg-muted/30 p-3">
            {kind === 'image' && !clientError ? (
              <ImageThumb file={file} />
            ) : (
              <div className="flex size-14 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground ring-1 ring-foreground/10">
                {kind === 'image' ? <FileImage aria-hidden="true" className="size-6" /> : <FileText aria-hidden="true" className="size-6" />}
              </div>
            )}
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <p className="truncate text-sm font-medium" title={file.name}>
                {file.name}
              </p>
              <p className="text-xs text-muted-foreground tabular-nums">{formatBytes(file.size)}</p>
            </div>
          </div>
        ) : null}

        {active ? (
          <div className="flex flex-col gap-1.5">
            <Progress
              value={phase === 'hashing' ? null : progress}
              aria-label="Progres unggahan"
              className={cn('h-2', phase === 'hashing' && 'animate-pulse motion-reduce:animate-none')}
            />
            {/* Visual detail only; the live region below announces phase changes, not every percent. */}
            <p className="text-xs text-muted-foreground tabular-nums" aria-hidden="true">
              {phase === 'uploading' ? `${UPLOAD_PHASE_MESSAGE.uploading} ${progress}%` : UPLOAD_PHASE_MESSAGE[phase]}
            </p>
          </div>
        ) : null}

        {profileMissing ? (
          <Alert variant="destructive">
            <UserRound />
            <AlertTitle>Lengkapi profil sebelum mengunggah dokumen</AlertTitle>
            <AlertDescription>
              <p>Belum diisi: {profileMissing}.</p>
              <Button asChild size="sm" variant="outline" className="mt-2">
                <Link to="/profil">Buka Profil</Link>
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}

        {otherError ? (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertTitle>{isConflict ? 'Dokumen tidak dapat diunggah' : 'Gagal mengunggah dokumen'}</AlertTitle>
            <AlertDescription>
              <p>{errorMessage(otherError)}</p>
              {isConflict ? (
                <Button size="sm" variant="outline" className="mt-2" disabled={reloading} onClick={() => void reload()}>
                  {reloading ? <Spinner data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" />}
                  Muat ulang
                </Button>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}

        {/* Always mounted so assistive tech reliably announces phase changes. */}
        <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
          {liveMessage}
        </p>
      </div>

      <DialogFooter>
        {phase === 'hashing' || phase === 'uploading' ? (
          <Button variant="outline" onClick={() => abortRef.current?.abort()}>
            Batalkan unggahan
          </Button>
        ) : (
          // While the server processes (100% sent) the upload can no longer be cancelled reliably.
          <Button variant="outline" onClick={onDone} disabled={phase === 'processing'}>
            {phase === 'processing' ? 'Memproses…' : 'Batal'}
          </Button>
        )}
        <Button onClick={() => void submit()} disabled={!file || !!clientError || active || !item.can.upload}>
          {active ? <Spinner data-icon="inline-start" /> : <Upload data-icon="inline-start" />}
          {isReupload ? 'Unggah Ulang' : 'Unggah'}
        </Button>
      </DialogFooter>
    </>
  );
}

/** Thumbnail via an object URL; assigned through a ref so StrictMode remounts never show a revoked URL. */
function ImageThumb({ file }: { file: File }) {
  const imgRef = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const url = URL.createObjectURL(file);
    if (imgRef.current) imgRef.current.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return (
    <img
      ref={imgRef}
      alt={`Pratinjau ${file.name}`}
      className="size-14 shrink-0 rounded-md bg-background object-cover ring-1 ring-foreground/10"
    />
  );
}
