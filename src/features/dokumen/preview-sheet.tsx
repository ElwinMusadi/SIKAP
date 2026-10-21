import { useState } from 'react';
import { ChevronDown, Download, Eye, ExternalLink, FileText, History, Info, RotateCcw, Trash2, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { DOCUMENT_POLICY, documentFileUrl, isViewableDocumentMime, type DokumenItem, type DokumenVersi } from '@shared/dokumen';
import { StatusBadge } from '@/components/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Separator } from '@/components/ui/separator';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { errorMessage } from '@/lib/api';
import { formatDateTimeWITA, formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';
import { UploadActionButton } from './document-actions';
import { RIWAYAT_LABEL, fileKind, formatBytes, formatCountdown } from './dokumen-utils';
import { useRiwayat, useRollbackDocument } from './queries';

interface PreviewSheetProps {
  item: DokumenItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpload: (item: DokumenItem) => void;
  onDelete: (item: DokumenItem) => void;
}

export function PreviewSheet({ item, open, onOpenChange, onUpload, onDelete }: PreviewSheetProps) {
  return (
    <Sheet open={open && item !== null} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 data-[side=right]:sm:max-w-3xl">
        {item ? (
          <PreviewBody key={item.jenisDokumenId} item={item} onUpload={onUpload} onDelete={onDelete} />
        ) : (
          <SheetHeader>
            <SheetTitle>Pratinjau dokumen</SheetTitle>
          </SheetHeader>
        )}
      </SheetContent>
    </Sheet>
  );
}

function PreviewBody({ item, onUpload, onDelete }: Omit<PreviewSheetProps, 'open' | 'onOpenChange' | 'item'> & { item: DokumenItem }) {
  const [selectedVersi, setSelectedVersi] = useState<number | null>(null);
  const [rollbackTarget, setRollbackTarget] = useState<DokumenVersi | null>(null);
  const arsip = item.arsip;

  // A version that was rolled back or purged disappears from the list: fall back to the current file.
  const version = item.versiSebelumnya.find((v) => v.versi === selectedVersi) ?? null;
  const shown = version
    ? { fileName: version.fileName, mimeType: version.mimeType, versi: version.versi }
    : arsip
      ? { fileName: arsip.fileName, mimeType: arsip.mimeType, versi: undefined }
      : null;

  return (
    <>
      <SheetHeader className="gap-2 border-b pr-12">
        <div className="flex flex-wrap items-center gap-2">
          <SheetTitle className="text-base">{item.nama}</SheetTitle>
          <StatusBadge status={item.status} />
        </div>
        <SheetDescription>
          {item.kategori} · {item.wajib ? 'Wajib' : 'Opsional'}
        </SheetDescription>
        {arsip ? (
          <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-[auto_1fr]">
            <dt className="text-muted-foreground">File</dt>
            <dd className="min-w-0 break-all">
              {arsip.fileName} <span className="text-muted-foreground">· {formatBytes(arsip.sizeBytes)} · versi {arsip.versi}</span>
            </dd>
            <dt className="text-muted-foreground">Diunggah</dt>
            <dd>{formatDateTimeWITA(arsip.uploadedAt)}</dd>
            {arsip.verifiedAt ? (
              <>
                <dt className="text-muted-foreground">{item.status === 'Ditolak' ? 'Diperiksa' : 'Diverifikasi'}</dt>
                <dd>
                  {formatDateTimeWITA(arsip.verifiedAt)}
                  {arsip.verifiedBy ? ` oleh ${arsip.verifiedBy.nama}` : ''}
                </dd>
              </>
            ) : null}
          </dl>
        ) : null}
        {arsip?.catatanAdmin ? (
          <Alert variant={item.status === 'Ditolak' ? 'destructive' : 'default'} className="mt-1">
            <TriangleAlert />
            <AlertTitle>Catatan admin</AlertTitle>
            <AlertDescription>{arsip.catatanAdmin}</AlertDescription>
          </Alert>
        ) : null}
      </SheetHeader>

      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4">
        {item.status === 'Menunggu' && item.can.delete ? (
          <Alert role="note">
            <Info />
            <AlertDescription>Salah unggah? Hapus dokumen ini lalu unggah ulang.</AlertDescription>
          </Alert>
        ) : null}
        {arsip && shown ? (
          <section aria-label="Pratinjau file" className="flex flex-col gap-2">
            {version ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/50 px-3 py-2 text-sm">
                <span>
                  Menampilkan <span className="font-medium">versi {version.versi}</span> (versi sebelumnya)
                </span>
                <Button size="sm" variant="ghost" onClick={() => setSelectedVersi(null)}>
                  Kembali ke file saat ini
                </Button>
              </div>
            ) : null}
            <FileViewer arsipId={arsip.id} {...shown} />
          </section>
        ) : (
          <Empty className="border border-dashed">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FileText />
              </EmptyMedia>
              <EmptyTitle>Belum ada file</EmptyTitle>
              <EmptyDescription>{item.uploadBlockedReason ?? 'Dokumen ini belum diunggah.'}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}

        {arsip && item.versiSebelumnya.length > 0 ? (
          <section aria-labelledby="versi-heading" className="flex flex-col gap-3">
            <div className="flex flex-col gap-0.5">
              <h3 id="versi-heading" className="text-sm font-semibold">
                Versi sebelumnya
              </h3>
              <p className="text-xs text-muted-foreground">
                Disimpan {DOCUMENT_POLICY.versionRetentionDays} hari setelah diganti, lalu dihapus permanen.
              </p>
            </div>
            <ul className="flex flex-col gap-2">
              {item.versiSebelumnya.map((v) => (
                <li
                  key={v.versi}
                  className={cn(
                    'flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center',
                    v.versi === selectedVersi && 'border-primary/50 bg-primary/5',
                  )}
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="secondary" className="tabular-nums">
                        Versi {v.versi}
                      </Badge>
                      <StatusBadge status={v.status} />
                    </div>
                    <p className="truncate text-sm font-medium" title={v.fileName}>
                      {v.fileName}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {formatBytes(v.sizeBytes)} · diganti {formatDateTimeWITA(v.replacedAt)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Tersedia sampai {formatDateTimeWITA(v.purgeAfter)}{' '}
                      <span className="font-medium text-status-pending">({formatCountdown(v.purgeAfter)})</span>
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setSelectedVersi(v.versi)}
                      aria-pressed={v.versi === selectedVersi}
                    >
                      <Eye data-icon="inline-start" />
                      Lihat
                    </Button>
                    {v.bisaDipulihkan ? (
                      <Button size="sm" variant="outline" onClick={() => setRollbackTarget(v)}>
                        <RotateCcw data-icon="inline-start" />
                        Pulihkan versi ini
                      </Button>
                    ) : item.status !== 'Terverifikasi' ? (
                      // Current file is still changeable, so the version itself is admin-only
                      // (a verified file that an admin deleted).
                      <span className="text-xs text-muted-foreground">Hanya admin yang dapat memulihkan versi ini.</span>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {arsip ? <RiwayatSection arsipId={arsip.id} /> : null}
      </div>

      {arsip ? (
        <SheetFooter className="flex-row flex-wrap gap-2 border-t">
          <Button asChild variant="outline" size="sm">
            <a href={documentFileUrl(arsip.id, { download: true, versi: shown?.versi })} rel="noopener" download>
              <Download data-icon="inline-start" />
              Unduh
            </a>
          </Button>
          {shown && isViewableDocumentMime(shown.mimeType) ? (
            <Button asChild variant="outline" size="sm">
              <a href={documentFileUrl(arsip.id, { versi: shown.versi })} target="_blank" rel="noopener noreferrer">
                <ExternalLink data-icon="inline-start" />
                Buka di tab baru
                <span className="sr-only"> (tab baru)</span>
              </a>
            </Button>
          ) : null}
          <div className="ml-auto flex flex-wrap gap-2">
            {item.can.delete ? (
              <Button variant="destructive" size="sm" onClick={() => onDelete(item)}>
                <Trash2 data-icon="inline-start" />
                Hapus
              </Button>
            ) : null}
            <UploadActionButton item={item} onUpload={onUpload} />
          </div>
        </SheetFooter>
      ) : null}

      <RollbackDialog
        item={item}
        version={rollbackTarget}
        onOpenChange={(open) => !open && setRollbackTarget(null)}
        onDone={() => setSelectedVersi(null)}
      />
    </>
  );
}

function FileViewer({
  arsipId,
  fileName,
  mimeType,
  versi,
}: {
  arsipId: number;
  fileName: string;
  mimeType: string;
  versi: number | undefined;
}) {
  const src = documentFileUrl(arsipId, { versi });
  const kind = isViewableDocumentMime(mimeType) ? fileKind(mimeType) : 'other';

  if (kind === 'pdf') {
    return (
      <iframe
        key={src}
        src={src}
        title={`Pratinjau ${fileName}`}
        className="h-[70vh] w-full rounded-md border bg-muted"
        referrerPolicy="no-referrer"
      />
    );
  }
  if (kind === 'image') {
    return (
      <div className="flex justify-center rounded-md border bg-muted/40 p-2">
        <img key={src} src={src} alt={fileName} className="max-h-[70vh] w-auto max-w-full object-contain" referrerPolicy="no-referrer" />
      </div>
    );
  }
  return (
    <Empty className="border border-dashed">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <FileText />
        </EmptyMedia>
        <EmptyTitle>Pratinjau tidak tersedia</EmptyTitle>
        <EmptyDescription>Jenis file ini tidak dapat ditampilkan di browser. Unduh file untuk membukanya.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button asChild size="sm" variant="outline">
          <a href={documentFileUrl(arsipId, { download: true, versi })} rel="noopener" download>
            <Download data-icon="inline-start" />
            Unduh
          </a>
        </Button>
      </EmptyContent>
    </Empty>
  );
}

function RollbackDialog({
  item,
  version,
  onOpenChange,
  onDone,
}: {
  item: DokumenItem;
  version: DokumenVersi | null;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const rollback = useRollbackDocument();

  const confirm = (event: React.MouseEvent) => {
    event.preventDefault();
    if (!item.arsip || !version) return;
    rollback.mutate(
      { arsipId: item.arsip.id, versi: version.versi },
      {
        onSuccess: () => {
          toast.success(`Versi ${version.versi} dipulihkan.`);
          onOpenChange(false);
          onDone();
        },
        onError: (error) => toast.error(errorMessage(error)),
      },
    );
  };

  return (
    <AlertDialog open={version !== null} onOpenChange={(open) => !rollback.isPending && onOpenChange(open)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Pulihkan versi {version?.versi}?</AlertDialogTitle>
          <AlertDialogDescription>
            File <span className="font-medium break-all text-foreground">{version?.fileName}</span> menjadi file aktif dan
            status dokumen kembali menjadi <span className="font-medium text-foreground">{version?.status}</span>. File saat
            ini disimpan sebagai versi sebelumnya selama {DOCUMENT_POLICY.versionRetentionDays} hari.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={rollback.isPending}>Batal</AlertDialogCancel>
          <AlertDialogAction onClick={confirm} disabled={rollback.isPending}>
            {rollback.isPending ? <Spinner data-icon="inline-start" /> : <RotateCcw data-icon="inline-start" />}
            Pulihkan versi
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function RiwayatSection({ arsipId }: { arsipId: number }) {
  const [open, setOpen] = useState(false);
  const riwayat = useRiwayat(arsipId, open);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="flex flex-col gap-3">
      <Separator />
      <CollapsibleTrigger asChild>
        <Button variant="ghost" className="w-full justify-between px-2">
          <span className="flex items-center gap-2 font-semibold">
            <History aria-hidden="true" className="size-4" />
            Riwayat
          </span>
          <ChevronDown aria-hidden="true" className={cn('transition-transform motion-reduce:transition-none', open && 'rotate-180')} />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        {riwayat.isPending ? (
          <div className="flex flex-col gap-3" aria-busy="true" aria-label="Memuat riwayat">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : riwayat.isError ? (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertTitle>Gagal memuat riwayat</AlertTitle>
            <AlertDescription>
              <p>{errorMessage(riwayat.error)}</p>
              <Button size="sm" variant="outline" className="mt-2" onClick={() => void riwayat.refetch()}>
                {riwayat.isFetching ? <Spinner data-icon="inline-start" /> : null}
                Coba lagi
              </Button>
            </AlertDescription>
          </Alert>
        ) : riwayat.data.items.length === 0 ? (
          <p className="px-2 text-sm text-muted-foreground">Belum ada riwayat.</p>
        ) : (
          <ol className="relative ml-3 flex flex-col gap-4 border-l pl-5">
            {riwayat.data.items.map((entry) => (
              <li key={entry.id} className="relative flex flex-col gap-0.5">
                <span
                  aria-hidden="true"
                  className={cn(
                    'absolute top-1.5 -left-[25px] size-2.5 rounded-full ring-4 ring-popover',
                    entry.aksi === 'APPROVE'
                      ? 'bg-status-verified'
                      : entry.aksi === 'REJECT'
                        ? 'bg-status-rejected'
                        : entry.aksi === 'DELETE'
                          ? 'bg-destructive'
                          : 'bg-muted-foreground',
                  )}
                />
                <p className="text-sm">
                  <span className="font-medium">{RIWAYAT_LABEL[entry.aksi]}</span>
                  <span className="text-muted-foreground">
                    {' '}
                    · versi {entry.versi}
                    {entry.actor ? ` · ${entry.actor.nama}` : ''}
                  </span>
                </p>
                <time dateTime={entry.createdAt} className="text-xs text-muted-foreground" title={formatDateTimeWITA(entry.createdAt)}>
                  {formatDateTimeWITA(entry.createdAt)} ({formatRelative(entry.createdAt)})
                </time>
                {entry.catatan ? <p className="text-sm text-muted-foreground">“{entry.catatan}”</p> : null}
              </li>
            ))}
          </ol>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
