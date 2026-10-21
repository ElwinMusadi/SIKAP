import { useEffect, useState } from 'react';
import {
  ChevronDown,
  Download,
  Ellipsis,
  Eye,
  FileImage,
  FilePlus,
  FileText,
  FolderOpen,
  LayoutGrid,
  List,
  Trash2,
  Undo2,
  Upload,
  UserRound,
} from 'lucide-react';
import { Link, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { documentFileUrl, type DokumenItem } from '@shared/dokumen';
import { PageHeader } from '@/components/page-header';
import { ProgressMeter } from '@/components/progress-meter';
import { SectionCard } from '@/components/section-card';
import { EmptyState, ErrorState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { errorMessage } from '@/lib/api';
import { formatDateTimeWITA, formatRelative } from '@/lib/format';
import { statusSpec, TONE_CLASSES } from '@/lib/status';
import { cn } from '@/lib/utils';
import { DeleteDocumentDialog, UploadActionButton } from './document-actions';
import { deepLinkTarget, fileKind, formatBytes, primaryAction, uploadChoices, wajibCounts } from './dokumen-utils';
import { PreviewSheet } from './preview-sheet';
import { useDocuments, useRestoreDocument } from './queries';
import { UploadDialog } from './upload-dialog';

type TabValue = 'wajib' | 'opsional';
type ViewMode = 'grid' | 'list';

const VIEW_STORAGE_KEY = 'sikap.dokumen.view';

function readViewMode(): ViewMode {
  try {
    return localStorage.getItem(VIEW_STORAGE_KEY) === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
}

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
  const [view, setView] = useState<ViewMode>(readViewMode);
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

  const changeView = (next: ViewMode) => {
    setView(next);
    try {
      localStorage.setItem(VIEW_STORAGE_KEY, next);
    } catch {
      // Storage unavailable: the choice lasts until reload.
    }
  };

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
      <PageHeader
        title="Arsip Dokumen"
        description="Unggah dan kelola dokumen kepegawaian Anda."
        actions={
          query.data ? (
            <UploadMenu items={query.data.items} profileIncomplete={query.data.profileMissingFields.length > 0} onUpload={handlers.onUpload} />
          ) : null
        }
      />

      {query.isPending ? (
        <PageSkeleton />
      ) : query.isError ? (
        <Card className="py-0">
          <ErrorState error={query.error} title="Gagal memuat arsip dokumen" onRetry={() => void query.refetch()} retrying={query.isFetching} />
        </Card>
      ) : (
        <>
          <SectionCard title="Kelengkapan dokumen wajib" description="Dihitung dari dokumen wajib yang sudah terverifikasi.">
            {query.data.summary.wajibTotal > 0 ? (
              <ProgressMeter counts={wajibCounts(query.data.items)} label="Terverifikasi" />
            ) : (
              <p className="text-sm text-muted-foreground">Belum ada dokumen wajib untuk status kepegawaian Anda.</p>
            )}
          </SectionCard>

          {query.data.profileMissingFields.length > 0 ? <ProfileCallout fields={query.data.profileMissingFields} /> : null}

          <DocumentCollection items={query.data.items} tab={tab} onTabChange={setTab} view={view} onViewChange={changeView} handlers={handlers} />
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
/* Header actions + callout                                                   */
/* -------------------------------------------------------------------------- */

/** "Unggah dokumen": pick the document type first (what still needs a file comes first). */
function UploadMenu({ items, profileIncomplete, onUpload }: { items: DokumenItem[]; profileIncomplete: boolean; onUpload: (item: DokumenItem) => void }) {
  const { needed, replace } = uploadChoices(items);
  const blockedReason = profileIncomplete
    ? 'Lengkapi profil terlebih dahulu.'
    : needed.length + replace.length === 0
      ? 'Tidak ada dokumen yang dapat diunggah saat ini.'
      : null;

  if (blockedReason) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} className="inline-flex rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50" aria-label={`Unggah dokumen: ${blockedReason}`}>
            <Button disabled tabIndex={-1} aria-hidden="true">
              <Upload data-icon="inline-start" />
              Unggah dokumen
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{blockedReason}</TooltipContent>
      </Tooltip>
    );
  }

  const row = (item: DokumenItem) => (
    <DropdownMenuItem key={item.jenisDokumenId} onSelect={() => onUpload(item)}>
      <StatusBadge status={item.status} iconOnly className="size-5" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{item.nama}</span>
        <span className="text-xs text-muted-foreground">{item.wajib ? 'Wajib' : 'Opsional'}</span>
      </span>
    </DropdownMenuItem>
  );

  return (
    // Non-modal: the menu opens a dialog, which must own focus afterwards.
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button>
          <Upload data-icon="inline-start" />
          Unggah dokumen
          <ChevronDown data-icon="inline-end" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-[min(28rem,var(--radix-dropdown-menu-content-available-height))] w-72 overflow-y-auto">
        {needed.length > 0 ? (
          <DropdownMenuGroup>
            <DropdownMenuLabel className="text-eyebrow text-muted-foreground uppercase">Perlu diunggah</DropdownMenuLabel>
            {needed.map(row)}
          </DropdownMenuGroup>
        ) : null}
        {needed.length > 0 && replace.length > 0 ? <DropdownMenuSeparator /> : null}
        {replace.length > 0 ? (
          <DropdownMenuGroup>
            <DropdownMenuLabel className="text-eyebrow text-muted-foreground uppercase">Ganti file</DropdownMenuLabel>
            {replace.map(row)}
          </DropdownMenuGroup>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ProfileCallout({ fields }: { fields: string[] }) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-status-pending/25 bg-status-pending-muted p-4 sm:flex-row sm:items-center">
      <UserRound className="size-5 shrink-0 text-status-pending" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p className="text-sm font-medium text-status-pending">Lengkapi profil sebelum mengunggah dokumen</p>
        <ul className="flex flex-wrap gap-1.5" aria-label="Data yang belum diisi">
          {fields.map((field) => (
            <li key={field}>
              <Badge variant="outline" className="bg-card">
                {field}
              </Badge>
            </li>
          ))}
        </ul>
      </div>
      <Button asChild size="sm" variant="outline" className="w-fit shrink-0 bg-card">
        <Link to="/profil">Lengkapi profil</Link>
      </Button>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Collection: tabs + grid / list                                             */
/* -------------------------------------------------------------------------- */

function DocumentCollection({
  items,
  tab,
  onTabChange,
  view,
  onViewChange,
  handlers,
}: {
  items: DokumenItem[];
  tab: TabValue;
  onTabChange: (tab: TabValue) => void;
  view: ViewMode;
  onViewChange: (view: ViewMode) => void;
  handlers: RowHandlers;
}) {
  if (items.length === 0) {
    return (
      <Card className="py-0">
        <EmptyState
          icon={FolderOpen}
          title="Belum ada daftar dokumen"
          description="Daftar dokumen muncul setelah status kepegawaian Anda terisi. Periksa data kepegawaian di halaman Profil."
          action={
            <Button asChild variant="outline" size="sm">
              <Link to="/profil#kepegawaian">Buka profil</Link>
            </Button>
          }
        />
      </Card>
    );
  }

  const wajib = items.filter((i) => i.wajib);
  const opsional = items.filter((i) => !i.wajib);
  const shown = tab === 'wajib' ? wajib : opsional;

  return (
    <section aria-label="Daftar dokumen" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs value={tab} onValueChange={(value) => onTabChange(value as TabValue)}>
          <TabsList>
            <TabsTrigger value="wajib">
              Wajib <span className="text-muted-foreground tabular-nums">{wajib.length}</span>
            </TabsTrigger>
            <TabsTrigger value="opsional">
              Opsional <span className="text-muted-foreground tabular-nums">{opsional.length}</span>
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          spacing={0}
          value={view}
          onValueChange={(value) => value && onViewChange(value as ViewMode)}
          aria-label="Tampilan daftar"
          className="hidden bg-card md:flex"
        >
          <ToggleGroupItem value="grid" aria-label="Tampilan kartu">
            <LayoutGrid />
          </ToggleGroupItem>
          <ToggleGroupItem value="list" aria-label="Tampilan tabel">
            <List />
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      {shown.length === 0 ? (
        <Card className="py-0">
          <EmptyState
            icon={FolderOpen}
            size="inline"
            title={tab === 'wajib' ? 'Tidak ada dokumen wajib' : 'Tidak ada dokumen opsional'}
            description={tab === 'wajib' ? 'Status kepegawaian Anda tidak mewajibkan dokumen apa pun.' : undefined}
          />
        </Card>
      ) : (
        <>
          {/* Phones always get cards; the table is a desktop alternative. */}
          <ul className={cn('grid gap-4 sm:grid-cols-2 xl:grid-cols-3', view === 'list' && 'md:hidden')}>
            {shown.map((item) => (
              <li key={item.jenisDokumenId} className="flex">
                <DocumentCard item={item} handlers={handlers} />
              </li>
            ))}
          </ul>
          {view === 'list' ? <DocumentTable items={shown} handlers={handlers} /> : null}
        </>
      )}
    </section>
  );
}

function DocumentIcon({ item, className }: { item: DokumenItem; className?: string }) {
  const Icon = !item.arsip ? FilePlus : fileKind(item.arsip.mimeType) === 'image' ? FileImage : FileText;
  const tone = TONE_CLASSES[statusSpec('dokumen', item.status).tone].soft;
  return (
    <span className={cn('flex size-10 shrink-0 items-center justify-center rounded-lg', tone, className)}>
      <Icon aria-hidden="true" className="size-5" />
    </span>
  );
}

function DocumentCard({ item, handlers }: { item: DokumenItem; handlers: RowHandlers }) {
  const arsip = item.arsip;
  return (
    <Card className="w-full gap-0 py-0">
      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="flex items-start gap-3">
          <DocumentIcon item={item} />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <p className="text-eyebrow text-muted-foreground uppercase">{item.kategori}</p>
            <h3 className="text-sm leading-snug font-semibold text-foreground">{item.nama}</h3>
          </div>
          <MoreActionsMenu item={item} handlers={handlers} />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusBadge status={item.status} />
          {arsip ? (
            <Badge variant="outline" className="text-muted-foreground tabular-nums">
              Versi {arsip.versi}
            </Badge>
          ) : null}
        </div>
        {arsip ? (
          <p className="text-xs text-muted-foreground">
            <span className="block truncate text-foreground" title={arsip.fileName}>
              {arsip.fileName}
            </span>
            {formatBytes(arsip.sizeBytes)} · diunggah <UploadedAt item={item} />
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">Belum ada file.</p>
        )}
        <DocumentNotes item={item} handlers={handlers} />
      </div>
      <div className="flex items-center gap-2 border-t bg-muted/30 px-4 py-3">
        <PrimaryActionButton item={item} handlers={handlers} />
      </div>
    </Card>
  );
}

/** Rejection note and soft-delete state, shared by cards and table rows. */
function DocumentNotes({ item, handlers, inline }: { item: DokumenItem; handlers: RowHandlers; inline?: boolean }) {
  return (
    <>
      {item.status === 'Ditolak' && item.arsip?.catatanAdmin ? (
        <p className="rounded-md border border-status-rejected/25 bg-status-rejected-muted px-2.5 py-1.5 text-xs text-status-rejected">
          <span className="font-medium">Catatan admin:</span> <span className="text-foreground">{item.arsip.catatanAdmin}</span>
        </p>
      ) : null}
      {item.deleted ? (
        item.can.restore ? (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="text-xs text-muted-foreground">Dihapus · dapat dipulihkan sampai {formatDateTimeWITA(item.deleted.purgeAfter)}</p>
            {/* In the table the primary button may already be "Pulihkan". */}
            {inline && primaryAction(item) !== 'restore' ? <RestoreButton item={item} handlers={handlers} variant="link" /> : null}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Dihapus oleh admin — hubungi admin untuk memulihkan.</p>
        )
      ) : null}
    </>
  );
}

function DocumentTable({ items, handlers }: { items: DokumenItem[]; handlers: RowHandlers }) {
  return (
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
                <div className="flex min-w-0 items-start gap-3">
                  <DocumentIcon item={item} className="size-9" />
                  <div className="flex min-w-0 flex-col gap-1">
                    <p className="text-sm leading-snug font-medium">{item.nama}</p>
                    <p className="text-xs text-muted-foreground">{item.kategori}</p>
                    <DocumentNotes item={item} handlers={handlers} inline />
                  </div>
                </div>
              </TableCell>
              <TableCell className="py-3 align-top">
                <StatusBadge status={item.status} />
              </TableCell>
              <TableCell className="py-3 align-top text-sm">
                {item.arsip ? <UploadedAt item={item} /> : <span className="text-muted-foreground">-</span>}
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
  );
}

function UploadedAt({ item }: { item: DokumenItem }) {
  if (!item.arsip) return null;
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
  if (action === 'upload') {
    return <UploadActionButton item={item} onUpload={handlers.onUpload} variant={item.can.upload ? 'default' : 'outline'} />;
  }
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
  // Restoring is not in the menu: it is the primary button or the inline "Pulihkan" link.
  const showDelete = arsip !== null && item.can.delete;

  if (!showView && !arsip && !showUpload && !showDelete) {
    // Keeps the action column aligned across rows.
    return <span aria-hidden="true" className="size-8 shrink-0" />;
  }

  return (
    // Non-modal: the menu opens dialogs/sheets, which must own focus and pointer events afterwards.
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button size="icon-sm" variant="ghost" className="-mt-1 -mr-1 shrink-0" aria-label={`Aksi lainnya untuk ${item.nama}`}>
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
            {arsip ? 'Unggah ulang' : 'Unggah'}
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

function PageSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Memuat arsip dokumen">
      <Skeleton className="h-36 rounded-xl" />
      <Skeleton className="h-9 w-56" />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-52 rounded-xl" />
        ))}
      </div>
    </div>
  );
}
