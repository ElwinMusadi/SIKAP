import { useEffect, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  CircleCheck,
  CircleDashed,
  Clock,
  Download,
  Ellipsis,
  Eye,
  FileImage,
  FileText,
  FolderOpen,
  RefreshCw,
  Trash2,
  TriangleAlert,
  Undo2,
  Upload,
  UserRound,
} from 'lucide-react';
import { Link, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { documentFileUrl, type DokumenItem, type DokumenListResponse } from '@shared/dokumen';
import type { StatusDokumenView } from '@shared/profile';
import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { errorMessage } from '@/lib/api';
import { formatDateTimeWITA, formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';
import { DeleteDocumentDialog, UploadActionButton } from './document-actions';
import { deepLinkTarget, fileKind, primaryAction } from './dokumen-utils';
import { PreviewSheet } from './preview-sheet';
import { useDocuments, useRestoreDocument } from './queries';
import { UploadDialog } from './upload-dialog';

type TabValue = 'wajib' | 'opsional';

interface RowHandlers {
  onUpload: (item: DokumenItem) => void;
  onPreview: (item: DokumenItem) => void;
  onDelete: (item: DokumenItem) => void;
  onRestore: (item: DokumenItem) => void;
  /** deleted.id currently being restored. */
  restoringId: number | null;
}

export default function DokumenPage() {
  const query = useDocuments();
  const restore = useRestoreDocument();
  const [searchParams, setSearchParams] = useSearchParams();

  const [tab, setTab] = useState<TabValue>('wajib');
  // Store ids, not items: the dialogs always render the latest server state of the item.
  const [uploadId, setUploadId] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const items = query.data?.items;
  const find = (id: string | null) => (id ? (items?.find((i) => i.jenisDokumenId === id) ?? null) : null);

  // Deep link `/dokumen?jenis=DOC-KTP`: consumed once the list is loaded (adjusting state during render).
  const jenisParam = searchParams.get('jenis');
  const [handledJenis, setHandledJenis] = useState<string | null>(null);
  if (jenisParam && items && handledJenis !== jenisParam) {
    setHandledJenis(jenisParam);
    const target = items.find((i) => i.jenisDokumenId === jenisParam);
    if (target) {
      setTab(target.wajib ? 'wajib' : 'opsional');
      const mode = deepLinkTarget(target);
      if (mode === 'upload') setUploadId(target.jenisDokumenId);
      else if (mode === 'preview') setPreviewId(target.jenisDokumenId);
    }
  }
  useEffect(() => {
    if (jenisParam && handledJenis === jenisParam) {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete('jenis');
          return next;
        },
        { replace: true },
      );
    }
  }, [jenisParam, handledJenis, setSearchParams]);

  const handlers: RowHandlers = {
    onUpload: (item) => setUploadId(item.jenisDokumenId),
    onPreview: (item) => setPreviewId(item.jenisDokumenId),
    onDelete: (item) => setDeleteId(item.jenisDokumenId),
    onRestore: (item) => {
      if (!item.deleted) return;
      restore.mutate(item.deleted.id, {
        onSuccess: () => toast.success(`${item.nama} berhasil dipulihkan.`),
        onError: (error) => toast.error(errorMessage(error)),
      });
    },
    restoringId: restore.isPending ? (restore.variables ?? null) : null,
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Arsip Dokumen" description="Unggah dan kelola dokumen kepegawaian Anda." />

      {query.isPending ? (
        <PageSkeleton />
      ) : query.isError ? (
        <Alert variant="destructive" role="alert">
          <TriangleAlert />
          <AlertTitle>Gagal memuat arsip dokumen</AlertTitle>
          <AlertDescription>
            <p>{errorMessage(query.error)}</p>
            <Button size="sm" variant="outline" className="mt-2" onClick={() => void query.refetch()}>
              {query.isFetching ? <Spinner data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" />}
              Coba lagi
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <>
          <SummaryCard summary={query.data.summary} />

          {query.data.profileMissingFields.length > 0 ? (
            <Alert className="border-status-pending/30 bg-status-pending-muted">
              <UserRound className="text-status-pending" />
              <AlertTitle>Lengkapi profil sebelum mengunggah dokumen</AlertTitle>
              <AlertDescription>
                <p>Data berikut masih kosong:</p>
                <ul className="mt-1 list-disc pl-5">
                  {query.data.profileMissingFields.map((field) => (
                    <li key={field}>{field}</li>
                  ))}
                </ul>
                <Button asChild size="sm" variant="outline" className="mt-2 bg-background">
                  <Link to="/profil">Lengkapi Profil</Link>
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}

          <DocumentTabs items={query.data.items} tab={tab} onTabChange={setTab} handlers={handlers} />
        </>
      )}

      <UploadDialog item={find(uploadId)} open={uploadId !== null} onOpenChange={(open) => !open && setUploadId(null)} />
      <PreviewSheet
        item={find(previewId)}
        open={previewId !== null}
        onOpenChange={(open) => !open && setPreviewId(null)}
        onUpload={handlers.onUpload}
        onDelete={handlers.onDelete}
      />
      <DeleteDocumentDialog
        item={find(deleteId)}
        onOpenChange={(open) => !open && setDeleteId(null)}
        onDeleted={(item) => {
          if (previewId === item.jenisDokumenId) setPreviewId(null);
        }}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Summary                                                                    */
/* -------------------------------------------------------------------------- */

const STATUS_CHIPS: { status: StatusDokumenView; icon: LucideIcon; tone: string }[] = [
  { status: 'Terverifikasi', icon: CircleCheck, tone: 'bg-status-verified-muted text-status-verified' },
  { status: 'Menunggu', icon: Clock, tone: 'bg-status-pending-muted text-status-pending' },
  { status: 'Ditolak', icon: TriangleAlert, tone: 'bg-status-rejected-muted text-status-rejected' },
  { status: 'Belum diunggah', icon: CircleDashed, tone: 'bg-status-missing-muted text-status-missing' },
];

function SummaryCard({ summary }: { summary: DokumenListResponse['summary'] }) {
  const { persen, wajibTerverifikasi, wajibTotal, wajibTersedia, counts } = summary;
  const done = wajibTotal > 0 && persen === 100;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Kelengkapan Dokumen Wajib</CardTitle>
        <CardDescription>Dihitung dari dokumen wajib yang sudah terverifikasi.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6 lg:flex-row lg:items-center">
        <div className="flex flex-1 flex-col gap-3">
          <div className="flex items-baseline gap-3">
            <span className={cn('text-4xl font-semibold tabular-nums', done && 'text-status-verified')}>{persen}%</span>
            <span className="text-sm text-muted-foreground">terverifikasi</span>
          </div>
          <Progress
            value={persen}
            className={cn('h-2', done && '*:bg-status-verified')}
            aria-label={`Dokumen wajib terverifikasi ${persen} persen`}
          />
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground tabular-nums">
              {wajibTerverifikasi} dari {wajibTotal}
            </span>{' '}
            dokumen wajib terverifikasi · <span className="tabular-nums">{wajibTersedia}</span> tersedia
          </p>
        </div>
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:w-[28rem] lg:shrink-0" aria-label="Jumlah dokumen per status">
          {STATUS_CHIPS.map((chip) => (
            <li key={chip.status} className="flex items-center gap-2.5 rounded-lg border px-3 py-2">
              <span className={cn('flex size-7 shrink-0 items-center justify-center rounded-md', chip.tone)}>
                <chip.icon aria-hidden="true" className="size-4" />
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="text-lg leading-tight font-semibold tabular-nums">{counts[chip.status] ?? 0}</span>
                <span className="truncate text-xs text-muted-foreground">{chip.status}</span>
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* List                                                                       */
/* -------------------------------------------------------------------------- */

function DocumentTabs({
  items,
  tab,
  onTabChange,
  handlers,
}: {
  items: DokumenItem[];
  tab: TabValue;
  onTabChange: (tab: TabValue) => void;
  handlers: RowHandlers;
}) {
  if (items.length === 0) {
    return (
      <Empty className="border border-dashed">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FolderOpen />
          </EmptyMedia>
          <EmptyTitle>Belum ada daftar dokumen</EmptyTitle>
          <EmptyDescription>
            Daftar dokumen muncul setelah status kepegawaian Anda terisi. Periksa data kepegawaian di halaman Profil.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const wajib = items.filter((i) => i.wajib);
  const opsional = items.filter((i) => !i.wajib);

  return (
    <Tabs value={tab} onValueChange={(value) => onTabChange(value as TabValue)} className="gap-4">
      <TabsList>
        <TabsTrigger value="wajib">
          Wajib <span className="tabular-nums text-muted-foreground">({wajib.length})</span>
        </TabsTrigger>
        <TabsTrigger value="opsional">
          Opsional <span className="tabular-nums text-muted-foreground">({opsional.length})</span>
        </TabsTrigger>
      </TabsList>
      <TabsContent value="wajib">
        <DocumentList items={wajib} handlers={handlers} emptyText="Tidak ada dokumen wajib untuk status kepegawaian Anda." />
      </TabsContent>
      <TabsContent value="opsional">
        <DocumentList items={opsional} handlers={handlers} emptyText="Tidak ada dokumen opsional." />
      </TabsContent>
    </Tabs>
  );
}

function DocumentList({ items, handlers, emptyText }: { items: DokumenItem[]; handlers: RowHandlers; emptyText: string }) {
  if (items.length === 0) {
    return (
      <Empty className="border border-dashed py-10">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FolderOpen />
          </EmptyMedia>
          <EmptyDescription>{emptyText}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <>
      {/* Desktop: table */}
      <Card className="hidden py-0 md:flex">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4">Dokumen</TableHead>
              <TableHead className="w-40">Status</TableHead>
              <TableHead className="w-40">Diunggah</TableHead>
              <TableHead className="w-48 pr-4 text-right">Aksi</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <TableRow key={item.jenisDokumenId}>
                <TableCell className="py-3 pl-4 align-top whitespace-normal">
                  <DocumentTitle item={item} handlers={handlers} />
                </TableCell>
                <TableCell className="py-3 align-top">
                  <StatusBadge status={item.status} />
                </TableCell>
                <TableCell className="py-3 align-top text-sm">
                  <UploadedAt item={item} />
                </TableCell>
                <TableCell className="py-3 pr-4 align-top">
                  <div className="flex items-center justify-end gap-1">
                    <PrimaryActionButton item={item} handlers={handlers} />
                    <MoreActionsMenu item={item} handlers={handlers} />
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      {/* Mobile: cards */}
      <ul className="flex flex-col gap-3 md:hidden">
        {items.map((item) => (
          <li key={item.jenisDokumenId}>
            <Card size="sm">
              <CardContent className="flex flex-col gap-3">
                <div className="flex items-start justify-between gap-3">
                  <DocumentTitle item={item} handlers={handlers} />
                  <StatusBadge status={item.status} className="shrink-0" />
                </div>
                {item.arsip ? (
                  <p className="text-xs text-muted-foreground">
                    Diunggah <UploadedAt item={item} />
                  </p>
                ) : null}
                <MobileActions item={item} handlers={handlers} />
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
    </>
  );
}

function DocumentTitle({ item, handlers }: { item: DokumenItem; handlers: RowHandlers }) {
  const kind = fileKind(item.arsip?.mimeType);
  const Icon = kind === 'image' ? FileImage : FileText;
  return (
    <div className="flex min-w-0 items-start gap-3">
      <span
        className={cn(
          'mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg',
          item.arsip ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
        )}
      >
        <Icon aria-hidden="true" className="size-4.5" />
      </span>
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-sm leading-snug font-medium">{item.nama}</p>
        <p className="text-xs text-muted-foreground">{item.kategori}</p>
        {item.status === 'Ditolak' && item.arsip?.catatanAdmin ? (
          <p className="rounded-md border border-status-rejected/30 bg-status-rejected-muted px-2 py-1 text-xs text-status-rejected">
            <span className="font-medium">Catatan admin:</span> {item.arsip.catatanAdmin}
          </p>
        ) : null}
        {item.deleted ? (
          item.can.restore ? (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <p className="text-xs text-muted-foreground">
                Dihapus · dapat dipulihkan sampai {formatDateTimeWITA(item.deleted.purgeAfter)}
              </p>
              {/* Desktop only when Pulihkan is not already the row's primary button; mobile has its own button. */}
              {primaryAction(item) !== 'restore' ? (
                <span className="hidden md:inline-flex">
                  <RestoreButton item={item} handlers={handlers} variant="link" />
                </span>
              ) : null}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Dihapus oleh admin — hubungi admin untuk memulihkan.</p>
          )
        ) : null}
      </div>
    </div>
  );
}

function UploadedAt({ item }: { item: DokumenItem }) {
  if (!item.arsip) return <span className="text-muted-foreground">-</span>;
  const { uploadedAt } = item.arsip;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <time dateTime={uploadedAt} tabIndex={0} className="rounded-sm underline decoration-dotted underline-offset-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
          {formatRelative(uploadedAt)}
        </time>
      </TooltipTrigger>
      <TooltipContent>{formatDateTimeWITA(uploadedAt)}</TooltipContent>
    </Tooltip>
  );
}

function RestoreButton({
  item,
  handlers,
  variant = 'outline',
}: {
  item: DokumenItem;
  handlers: RowHandlers;
  variant?: 'outline' | 'default' | 'link';
}) {
  const pending = item.deleted !== null && handlers.restoringId === item.deleted.id;
  return (
    <Button
      size="sm"
      variant={variant}
      className={cn(variant === 'link' && 'h-auto px-0 text-xs')}
      disabled={handlers.restoringId !== null}
      onClick={() => handlers.onRestore(item)}
    >
      {pending ? <Spinner data-icon="inline-start" /> : <Undo2 data-icon="inline-start" />}
      Pulihkan
    </Button>
  );
}

function PrimaryActionButton({ item, handlers }: { item: DokumenItem; handlers: RowHandlers }) {
  const action = primaryAction(item);
  if (action === 'restore') return <RestoreButton item={item} handlers={handlers} />;
  if (action === 'upload') return <UploadActionButton item={item} onUpload={handlers.onUpload} variant="outline" />;
  return (
    <Button size="sm" variant="outline" onClick={() => handlers.onPreview(item)}>
      <Eye data-icon="inline-start" />
      Lihat
    </Button>
  );
}

function MoreActionsMenu({ item, handlers }: { item: DokumenItem; handlers: RowHandlers }) {
  const action = primaryAction(item);
  const arsip = item.arsip;
  const showView = arsip !== null && action !== 'view';
  const showUpload = item.can.upload && action !== 'upload';
  // Restoring is not in the menu: it is the primary button or the inline "Pulihkan" link in the title.
  const showDelete = arsip !== null && item.can.delete;

  if (!showView && !arsip && !showUpload && !showDelete) {
    // Keeps the action column aligned across rows.
    return <span aria-hidden="true" className="size-7" />;
  }

  return (
    // Non-modal: the menu opens dialogs/sheets, which must own focus and pointer events afterwards.
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button size="icon-sm" variant="ghost" aria-label={`Aksi lainnya untuk ${item.nama}`}>
          <Ellipsis />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        {showView ? (
          <DropdownMenuItem onSelect={() => handlers.onPreview(item)}>
            <Eye />
            Lihat
          </DropdownMenuItem>
        ) : null}
        {arsip ? (
          <DropdownMenuItem asChild>
            <a href={documentFileUrl(arsip.id, { download: true })} rel="noopener" download>
              <Download />
              Unduh
            </a>
          </DropdownMenuItem>
        ) : null}
        {showUpload ? (
          <DropdownMenuItem onSelect={() => handlers.onUpload(item)}>
            <Upload />
            {arsip ? 'Unggah Ulang' : 'Unggah'}
          </DropdownMenuItem>
        ) : null}
        {showDelete ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => handlers.onDelete(item)}>
              <Trash2 />
              Hapus
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MobileActions({ item, handlers }: { item: DokumenItem; handlers: RowHandlers }) {
  const arsip = item.arsip;
  const showUpload = item.can.upload || primaryAction(item) === 'upload';
  return (
    <div className="flex flex-wrap gap-2">
      {item.deleted && item.can.restore ? <RestoreButton item={item} handlers={handlers} /> : null}
      {showUpload ? <UploadActionButton item={item} onUpload={handlers.onUpload} variant="outline" /> : null}
      {arsip ? (
        <>
          <Button size="sm" variant="outline" onClick={() => handlers.onPreview(item)}>
            <Eye data-icon="inline-start" />
            Lihat
          </Button>
          <Button asChild size="sm" variant="outline">
            <a href={documentFileUrl(arsip.id, { download: true })} rel="noopener" download>
              <Download data-icon="inline-start" />
              Unduh
            </a>
          </Button>
          {item.can.delete ? (
            <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => handlers.onDelete(item)}>
              <Trash2 data-icon="inline-start" />
              Hapus
            </Button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function PageSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Memuat arsip dokumen">
      <Card>
        <CardContent className="flex flex-col gap-4 lg:flex-row lg:items-center">
          <div className="flex flex-1 flex-col gap-3">
            <Skeleton className="h-10 w-28" />
            <Skeleton className="h-2 w-full" />
            <Skeleton className="h-4 w-72" />
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:w-[28rem]">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-14 rounded-lg" />
            ))}
          </div>
        </CardContent>
      </Card>
      <Skeleton className="h-8 w-56" />
      <div className="flex flex-col gap-2">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-16 rounded-lg" />
        ))}
      </div>
    </div>
  );
}
