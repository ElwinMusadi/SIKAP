import { useEffect, useEffectEvent, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FileText,
  Inbox,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  TriangleAlert,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { documentFileUrl, isViewableDocumentMime } from '@shared/dokumen';
import { rejectRequestSchema, type DecisionResponse, type VerifikasiItem } from '@shared/verifikasi';
import { PageHeader } from '@/components/page-header';
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
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { useMe } from '@/features/auth/queries';
import { fileKind, formatBytes } from '@/features/dokumen/dokumen-utils';
import { useRefData } from '@/features/profil/queries';
import { errorMessage, isApiError } from '@/lib/api';
import { formatDateTimeWITA, formatRelative, initials } from '@/lib/format';
import { cn } from '@/lib/utils';
import { isStaleDecisionError, useApprove, useDecisionPending, useReject, useVerifikasiQueue } from './queries';
import { ALASAN_MAX, REJECT_QUICK_REASONS, appendReason, flattenQueue, neighborId, shortcutAction } from './verifikasi-utils';

const ALL = 'all';
const DESKTOP_QUERY = '(min-width: 1024px)';

function subscribeDesktop(onChange: () => void) {
  const mql = window.matchMedia(DESKTOP_QUERY);
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}

/** lg+ (two-pane layout). Only one layout is mounted so the preview iframe never loads twice. */
function useIsDesktop() {
  return useSyncExternalStore(
    subscribeDesktop,
    () => window.matchMedia(DESKTOP_QUERY).matches,
    () => true,
  );
}

function successMessage(kind: 'approve' | 'reject', item: VerifikasiItem, res: DecisionResponse) {
  const base = `${item.jenisDokumen.nama} milik ${item.pegawai.nama} ${kind === 'approve' ? 'disetujui' : 'ditolak'}.`;
  return res.notifikasi === 'TANPA_NOMOR' ? `${base} (pegawai belum mengisi nomor HP, notifikasi WA tidak dikirim)` : base;
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function VerifikasiPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const jenis = searchParams.get('jenis') || null;
  const isDesktop = useIsDesktop();
  const { data: me } = useMe();
  const ref = useRefData();
  const queue = useVerifikasiQueue(jenis);
  const approve = useApprove();
  const reject = useReject();
  const decisionPending = useDecisionPending();

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [confirmItem, setConfirmItem] = useState<VerifikasiItem | null>(null);
  const [rejectItem, setRejectItem] = useState<VerifikasiItem | null>(null);
  const [rejectFieldError, setRejectFieldError] = useState<string | null>(null);
  const actionsRef = useRef<HTMLDivElement>(null);

  const items = useMemo(() => flattenQueue(queue.data), [queue.data]);
  const firstPage = queue.data?.pages[0];
  const total = firstPage?.total ?? 0;
  const explicit = items.find((item) => item.arsipId === selectedId) ?? null;
  // Desktop always shows an item (the oldest by default); mobile shows one only in the sheet.
  const selected = explicit ?? (isDesktop ? (items[0] ?? null) : null);
  const selectedIndex = selected ? items.indexOf(selected) : -1;
  const isOwn = (item: VerifikasiItem) => me !== null && me !== undefined && item.pegawai.id === me.id;

  const jenisOptions = useMemo(() => {
    const names = new Map<string, string>();
    for (const j of ref.data?.jenisDokumen ?? []) names.set(j.id, j.nama);
    for (const item of items) if (!names.has(item.jenisDokumen.id)) names.set(item.jenisDokumen.id, item.jenisDokumen.nama);
    const order = [...names.keys()];
    const counts = firstPage?.perJenis ?? {};
    const ids = Object.keys(counts).filter((id) => counts[id]! > 0 || id === jenis);
    if (jenis && !ids.includes(jenis)) ids.push(jenis);
    ids.sort((a, b) => {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      return (ia < 0 ? Infinity : ia) - (ib < 0 ? Infinity : ib) || a.localeCompare(b);
    });
    return ids.map((id) => ({ id, nama: names.get(id) ?? id, count: counts[id] ?? 0 }));
  }, [ref.data, items, firstPage, jenis]);

  const changeJenis = (value: string) => {
    setSelectedId(null);
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value === ALL) next.delete('jenis');
        else next.set('jenis', value);
        return next;
      },
      { replace: true },
    );
  };

  const selectFromList = (item: VerifikasiItem) => {
    setSelectedId(item.arsipId);
    // Move focus to the decision controls after an explicit choice (never on initial load).
    if (isDesktop) requestAnimationFrame(() => actionsRef.current?.focus({ preventScroll: false }));
  };

  const step = (delta: 1 | -1) => {
    if (items.length === 0) return;
    const index = selectedIndex < 0 ? 0 : selectedIndex + delta;
    if (index >= items.length) {
      if (queue.hasNextPage && !queue.isFetchingNextPage) void queue.fetchNextPage();
      return;
    }
    const target = items[Math.max(0, index)];
    if (!target) return;
    setSelectedId(target.arsipId);
    requestAnimationFrame(() => document.getElementById(`antrean-${target.arsipId}`)?.scrollIntoView({ block: 'nearest' }));
  };

  const decide = (kind: 'approve' | 'reject', item: VerifikasiItem, alasan?: string) => {
    const next = neighborId(items, item.arsipId);
    const mutation = kind === 'approve' ? approve : reject;
    mutation.mutate(
      { item, alasan },
      {
        onSuccess: (res) => {
          toast.success(successMessage(kind, item, res));
          setSelectedId((current) => (current === null || current === item.arsipId ? next : current));
          setConfirmItem(null);
          setRejectItem(null);
        },
        onError: (error) => {
          if (isStaleDecisionError(error)) {
            // The hook already toasts and reloads the queue.
            setConfirmItem(null);
            setRejectItem(null);
            return;
          }
          if (kind === 'reject' && isApiError(error, 'VALIDATION_ERROR') && error.fields?.alasan) {
            setRejectFieldError(error.fields.alasan);
            return;
          }
          toast.error(errorMessage(error));
          if (isApiError(error, 'FORBIDDEN')) {
            setConfirmItem(null);
            setRejectItem(null);
          }
        },
      },
    );
  };

  const openApprove = (item: VerifikasiItem) => {
    if (isOwn(item)) return;
    setConfirmItem(item);
  };
  const openReject = (item: VerifikasiItem) => {
    if (isOwn(item)) return;
    setRejectFieldError(null);
    setRejectItem(item);
  };

  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    const action = shortcutAction(event, {
      blocked: !isDesktop || confirmItem !== null || rejectItem !== null || decisionPending || queue.isPlaceholderData,
    });
    if (!action) return;
    event.preventDefault();
    if (action === 'next') return step(1);
    if (action === 'prev') return step(-1);
    if (!selected) return;
    if (isOwn(selected)) {
      toast.info('Dokumen Anda sendiri harus diverifikasi admin lain.');
      return;
    }
    if (action === 'approve') openApprove(selected);
    else openReject(selected);
  });

  useEffect(() => {
    if (!isDesktop) return;
    const handler = (event: KeyboardEvent) => onKeyDown(event);
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isDesktop]);

  const filter = (
    <Select value={jenis ?? ALL} onValueChange={changeJenis} disabled={queue.isPending}>
      <SelectTrigger className="w-full sm:w-72" aria-label="Filter jenis dokumen">
        <SelectValue placeholder="Semua jenis" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectItem value={ALL}>Semua jenis ({total})</SelectItem>
          {jenisOptions.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              {option.nama} ({option.count})
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );

  let body: ReactNode;
  if (queue.isPending) {
    body = <QueueSkeleton isDesktop={isDesktop} />;
  } else if (queue.isError) {
    body = (
      <Alert variant="destructive">
        <TriangleAlert />
        <AlertTitle>Gagal memuat antrean verifikasi</AlertTitle>
        <AlertDescription>
          <p>{errorMessage(queue.error)}</p>
          <Button size="sm" variant="outline" className="mt-2" onClick={() => void queue.refetch()}>
            {queue.isFetching ? <Spinner data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" />}
            Coba lagi
          </Button>
        </AlertDescription>
      </Alert>
    );
  } else if (items.length === 0) {
    const filtered = jenis !== null && total > 0;
    body = (
      <Empty className="border border-dashed">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Inbox />
          </EmptyMedia>
          <EmptyTitle>{filtered ? 'Tidak ada dokumen untuk jenis ini' : 'Antrean kosong'}</EmptyTitle>
          <EmptyDescription>
            {filtered
              ? `Masih ada ${total} dokumen lain yang menunggu verifikasi.`
              : 'Tidak ada dokumen yang menunggu verifikasi.'}
          </EmptyDescription>
        </EmptyHeader>
        {filtered ? (
          <EmptyContent>
            <Button variant="outline" onClick={() => changeJenis(ALL)}>
              Tampilkan semua jenis
            </Button>
          </EmptyContent>
        ) : null}
      </Empty>
    );
  } else {
    const list = (
      <QueueList
        items={items}
        selectedId={selected?.arsipId ?? null}
        onSelect={selectFromList}
        hasNextPage={queue.hasNextPage}
        isFetchingNextPage={queue.isFetchingNextPage}
        onLoadMore={() => void queue.fetchNextPage()}
        busy={queue.isPlaceholderData}
      />
    );
    const actions = (item: VerifikasiItem) => (
      <DecisionActions
        item={item}
        own={isOwn(item)}
        pending={decisionPending || queue.isPlaceholderData}
        onApprove={() => openApprove(item)}
        onReject={() => openReject(item)}
        showShortcuts={isDesktop}
      />
    );

    body = isDesktop ? (
      <div className="grid grid-cols-[minmax(0,3fr)_minmax(0,2fr)] items-start gap-6">
        <section aria-label="Pratinjau dokumen" className="sticky top-20 flex min-w-0 flex-col gap-2">
          {selected ? <DocumentPreview key={`${selected.arsipId}-${selected.versi}`} item={selected} /> : null}
        </section>
        <section aria-label="Detail dan tindakan verifikasi" className="flex min-w-0 flex-col gap-4">
          {selected ? (
            <Card>
              <CardHeader className="flex flex-row items-center justify-between gap-2">
                <CardTitle className="text-sm text-muted-foreground tabular-nums">
                  Dokumen {selectedIndex + 1} dari {total}
                </CardTitle>
                <div className="flex gap-1">
                  <Button size="icon-sm" variant="ghost" onClick={() => step(-1)} disabled={selectedIndex <= 0} aria-label="Dokumen sebelumnya">
                    <ChevronLeft />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    onClick={() => step(1)}
                    disabled={selectedIndex >= items.length - 1 && !queue.hasNextPage}
                    aria-label="Dokumen berikutnya"
                  >
                    <ChevronRight />
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="flex flex-col gap-5">
                <ItemDetails item={selected} />
                <Separator />
                <div ref={actionsRef} tabIndex={-1} role="group" aria-label="Tindakan verifikasi" className="rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
                  {actions(selected)}
                </div>
              </CardContent>
            </Card>
          ) : null}
          <Card>
            <CardHeader>
              <CardTitle>Antrean</CardTitle>
              <CardDescription>Diurutkan dari unggahan paling lama.</CardDescription>
            </CardHeader>
            <CardContent>{list}</CardContent>
          </Card>
        </section>
      </div>
    ) : (
      <>
        <section aria-label="Antrean verifikasi">{list}</section>
        <Sheet open={explicit !== null} onOpenChange={(open) => !open && !decisionPending && setSelectedId(null)}>
          <SheetContent
            side="right"
            className="w-full gap-0 data-[side=right]:sm:max-w-xl"
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              actionsRef.current?.focus();
            }}
          >
            {explicit ? (
              <>
                <SheetHeader className="border-b pr-12">
                  <SheetTitle className="text-base">{explicit.jenisDokumen.nama}</SheetTitle>
                  <SheetDescription>{explicit.pegawai.nama}</SheetDescription>
                </SheetHeader>
                <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4">
                  <section aria-label="Pratinjau dokumen" className="flex flex-col gap-2">
                    <DocumentPreview key={`${explicit.arsipId}-${explicit.versi}`} item={explicit} />
                  </section>
                  <ItemDetails item={explicit} />
                </div>
                <SheetFooter className="border-t">
                  <div ref={actionsRef} tabIndex={-1} role="group" aria-label="Tindakan verifikasi" className="rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
                    {actions(explicit)}
                  </div>
                </SheetFooter>
              </>
            ) : (
              <SheetHeader>
                <SheetTitle>Verifikasi dokumen</SheetTitle>
              </SheetHeader>
            )}
          </SheetContent>
        </Sheet>
      </>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Verifikasi Dokumen"
        description={queue.isPending ? 'Memuat antrean…' : `${total} dokumen menunggu verifikasi`}
        actions={filter}
      />
      {body}

      <ApproveDialog
        item={confirmItem}
        pending={approve.isPending}
        onOpenChange={(open) => !open && !approve.isPending && setConfirmItem(null)}
        onConfirm={(item) => decide('approve', item)}
      />
      <RejectDialog
        item={rejectItem}
        pending={reject.isPending}
        serverError={rejectFieldError}
        onOpenChange={(open) => !open && !reject.isPending && setRejectItem(null)}
        onSubmit={(item, alasan) => {
          setRejectFieldError(null);
          decide('reject', item, alasan);
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Queue list                                                          */
/* ------------------------------------------------------------------ */

function QueueList({
  items,
  selectedId,
  onSelect,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  busy,
}: {
  items: VerifikasiItem[];
  selectedId: number | null;
  onSelect: (item: VerifikasiItem) => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
  busy: boolean;
}) {
  return (
    <div className="flex flex-col gap-3" aria-busy={busy || undefined}>
      <ul className={cn('flex flex-col gap-1.5 lg:max-h-96 lg:overflow-y-auto lg:pr-1', busy && 'opacity-60')}>
        {items.map((item) => {
          const active = item.arsipId === selectedId;
          return (
            <li key={item.arsipId}>
              <button
                id={`antrean-${item.arsipId}`}
                type="button"
                onClick={() => onSelect(item)}
                aria-current={active ? 'true' : undefined}
                className={cn(
                  'flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors outline-none hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50 motion-reduce:transition-none',
                  active ? 'border-primary/40 bg-primary/5' : 'border-border',
                )}
              >
                <Avatar className="size-8 shrink-0">
                  {item.pegawai.fotoUrl ? <AvatarImage src={item.pegawai.fotoUrl} alt="" /> : null}
                  <AvatarFallback className="text-xs">{initials(item.pegawai.nama)}</AvatarFallback>
                </Avatar>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-sm font-medium">{item.pegawai.nama}</span>
                  <span className="truncate text-xs text-muted-foreground">{item.jenisDokumen.nama}</span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-1">
                  <time dateTime={item.uploadedAt} className="text-xs text-muted-foreground" title={formatDateTimeWITA(item.uploadedAt)}>
                    {formatRelative(item.uploadedAt)}
                  </time>
                  {item.isReupload ? (
                    <Badge variant="outline" className="border-status-pending/30 bg-status-pending-muted text-status-pending">
                      Ulang
                    </Badge>
                  ) : null}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {hasNextPage ? (
        <Button variant="outline" onClick={onLoadMore} disabled={isFetchingNextPage} className="self-center">
          {isFetchingNextPage ? <Spinner data-icon="inline-start" /> : null}
          Muat lebih banyak
        </Button>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Details + actions                                                   */
/* ------------------------------------------------------------------ */

function ItemDetails({ item }: { item: VerifikasiItem }) {
  const { pegawai, jenisDokumen, file } = item;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start gap-3">
        <Avatar className="size-11 shrink-0">
          {pegawai.fotoUrl ? <AvatarImage src={pegawai.fotoUrl} alt="" /> : null}
          <AvatarFallback>{initials(pegawai.nama)}</AvatarFallback>
        </Avatar>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium">{pegawai.nama}</p>
            {pegawai.statusKepegawaian ? <Badge variant="secondary">{pegawai.statusKepegawaian}</Badge> : null}
          </div>
          <p className="text-xs text-muted-foreground tabular-nums">NIP {pegawai.nip}</p>
          {pegawai.jabatan || pegawai.unit ? (
            <p className="text-sm text-muted-foreground">{[pegawai.jabatan, pegawai.unit].filter(Boolean).join(' · ')}</p>
          ) : null}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-heading text-base font-semibold">{jenisDokumen.nama}</h2>
          <Badge variant={jenisDokumen.wajib ? 'default' : 'outline'}>{jenisDokumen.wajib ? 'Wajib' : 'Opsional'}</Badge>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Kategori</dt>
          <dd>{jenisDokumen.kategori}</dd>
          <dt className="text-muted-foreground">File</dt>
          <dd className="min-w-0 break-all">
            {file.fileName} <span className="text-muted-foreground">· {formatBytes(file.sizeBytes)}</span>
          </dd>
          <dt className="text-muted-foreground">Diunggah</dt>
          <dd>
            <time dateTime={item.uploadedAt}>{formatRelative(item.uploadedAt)}</time>
            <span className="text-muted-foreground"> · {formatDateTimeWITA(item.uploadedAt)}</span>
          </dd>
        </dl>
      </div>

      {item.isReupload ? (
        <Alert className="border-status-pending/30 bg-status-pending-muted">
          <RotateCcw className="text-status-pending" />
          <AlertTitle>Unggahan ulang</AlertTitle>
          <AlertDescription>
            {item.catatanSebelumnya ? (
              <p>
                Alasan penolakan sebelumnya: <span className="text-foreground">“{item.catatanSebelumnya}”</span>
              </p>
            ) : (
              <p>Dokumen ini sudah pernah diperiksa sebelumnya.</p>
            )}
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

function DecisionActions({
  item,
  own,
  pending,
  onApprove,
  onReject,
  showShortcuts,
}: {
  item: VerifikasiItem;
  own: boolean;
  pending: boolean;
  onApprove: () => void;
  onReject: () => void;
  showShortcuts: boolean;
}) {
  return (
    <div className="flex w-full flex-col gap-3">
      {own ? (
        <Alert>
          <ShieldAlert />
          <AlertTitle>Tidak dapat memverifikasi</AlertTitle>
          <AlertDescription>Dokumen Anda sendiri harus diverifikasi admin lain.</AlertDescription>
        </Alert>
      ) : null}
      <div className="grid grid-cols-2 gap-2">
        <Button
          variant="outline"
          className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={onReject}
          disabled={own || pending}
          aria-keyshortcuts={showShortcuts ? 'R' : undefined}
        >
          <X data-icon="inline-start" />
          Tolak
        </Button>
        <Button onClick={onApprove} disabled={own || pending} aria-keyshortcuts={showShortcuts ? 'A' : undefined}>
          {pending ? <Spinner data-icon="inline-start" /> : <Check data-icon="inline-start" />}
          Setujui
        </Button>
      </div>
      {showShortcuts ? (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="font-medium">Pintasan keyboard:</span>
          <span>
            <Kbd>A</Kbd> setujui
          </span>
          <span>
            <Kbd>R</Kbd> tolak
          </span>
          <span>
            <Kbd>J</Kbd>/<Kbd>K</Kbd> berikutnya/sebelumnya
          </span>
        </p>
      ) : null}
      <span className="sr-only">
        {item.jenisDokumen.nama}, {item.pegawai.nama}
      </span>
    </div>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border bg-muted px-1 py-px font-mono text-[0.7rem] text-foreground">{children}</kbd>;
}

/* ------------------------------------------------------------------ */
/* Preview                                                             */
/* ------------------------------------------------------------------ */

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.25;

function DocumentPreview({ item }: { item: VerifikasiItem }) {
  const [zoom, setZoom] = useState(1);
  const src = documentFileUrl(item.arsipId);
  const kind = isViewableDocumentMime(item.file.mimeType) ? fileKind(item.file.mimeType) : 'other';

  const toolbar = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      {kind === 'image' ? (
        <div className="flex items-center gap-1" role="group" aria-label="Perbesaran gambar">
          <Button size="icon-sm" variant="outline" onClick={() => setZoom((z) => Math.max(ZOOM_MIN, z - ZOOM_STEP))} disabled={zoom <= ZOOM_MIN} aria-label="Perkecil">
            <ZoomOut />
          </Button>
          <span className="w-12 text-center text-xs text-muted-foreground tabular-nums" aria-live="polite">
            {Math.round(zoom * 100)}%
          </span>
          <Button size="icon-sm" variant="outline" onClick={() => setZoom((z) => Math.min(ZOOM_MAX, z + ZOOM_STEP))} disabled={zoom >= ZOOM_MAX} aria-label="Perbesar">
            <ZoomIn />
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setZoom(1)} disabled={zoom === 1}>
            Reset
          </Button>
        </div>
      ) : (
        <span />
      )}
      <div className="flex gap-2">
        <Button asChild size="sm" variant="ghost">
          <a href={documentFileUrl(item.arsipId, { download: true })} rel="noopener" download>
            <Download data-icon="inline-start" />
            Unduh
          </a>
        </Button>
        {kind !== 'other' ? (
          <Button asChild size="sm" variant="ghost">
            <a href={src} target="_blank" rel="noopener noreferrer">
              <ExternalLink data-icon="inline-start" />
              Buka di tab baru
              <span className="sr-only"> (tab baru)</span>
            </a>
          </Button>
        ) : null}
      </div>
    </div>
  );

  let viewer: ReactNode;
  if (kind === 'pdf') {
    viewer = (
      <iframe
        src={src}
        title={`Pratinjau ${item.jenisDokumen.nama} — ${item.pegawai.nama}`}
        className="h-[70svh] w-full rounded-md border bg-muted lg:h-[calc(100svh-11rem)] lg:min-h-[28rem]"
        referrerPolicy="no-referrer"
      />
    );
  } else if (kind === 'image') {
    viewer = (
      <div className="flex h-[60svh] overflow-auto rounded-md border bg-muted/40 p-2 lg:h-[calc(100svh-11rem)] lg:min-h-[28rem]">
        <img
          src={src}
          alt={`${item.jenisDokumen.nama} milik ${item.pegawai.nama}`}
          referrerPolicy="no-referrer"
          className={cn('m-auto object-contain', zoom === 1 ? 'max-h-full max-w-full' : 'max-w-none')}
          style={zoom === 1 ? undefined : { width: `${zoom * 100}%` }}
        />
      </div>
    );
  } else {
    viewer = (
      <Empty className="border border-dashed">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FileText />
          </EmptyMedia>
          <EmptyTitle>Pratinjau tidak tersedia</EmptyTitle>
          <EmptyDescription>Jenis file ini tidak dapat ditampilkan di browser. Unduh file untuk memeriksanya.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button asChild size="sm" variant="outline">
            <a href={documentFileUrl(item.arsipId, { download: true })} rel="noopener" download>
              <Download data-icon="inline-start" />
              Unduh
            </a>
          </Button>
        </EmptyContent>
      </Empty>
    );
  }

  return (
    <>
      {toolbar}
      {viewer}
    </>
  );
}

function QueueSkeleton({ isDesktop }: { isDesktop: boolean }) {
  const rows = (
    <div className="flex flex-col gap-2">
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} className="h-14 w-full" />
      ))}
    </div>
  );
  if (!isDesktop) return <div aria-busy="true" aria-label="Memuat antrean">{rows}</div>;
  return (
    <div className="grid grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-6" aria-busy="true" aria-label="Memuat antrean">
      <Skeleton className="h-[calc(100svh-11rem)] min-h-[28rem] w-full" />
      <div className="flex flex-col gap-4">
        <Skeleton className="h-72 w-full" />
        {rows}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Dialogs                                                             */
/* ------------------------------------------------------------------ */

function ApproveDialog({
  item,
  pending,
  onOpenChange,
  onConfirm,
}: {
  item: VerifikasiItem | null;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (item: VerifikasiItem) => void;
}) {
  const actionRef = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog open={item !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent
        size="sm"
        onOpenAutoFocus={(event) => {
          // Enter confirms: focus the primary action instead of Cancel.
          event.preventDefault();
          actionRef.current?.focus();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Setujui dokumen?</AlertDialogTitle>
          <AlertDialogDescription>
            <span className="font-medium text-foreground">{item?.jenisDokumen.nama}</span> milik{' '}
            <span className="font-medium text-foreground">{item?.pegawai.nama}</span> akan ditandai terverifikasi.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Batal</AlertDialogCancel>
          <AlertDialogAction
            ref={actionRef}
            disabled={pending}
            onClick={(event) => {
              event.preventDefault();
              if (item) onConfirm(item);
            }}
          >
            {pending ? <Spinner data-icon="inline-start" /> : <Check data-icon="inline-start" />}
            Setujui
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function RejectDialog({
  item,
  pending,
  serverError,
  onOpenChange,
  onSubmit,
}: {
  item: VerifikasiItem | null;
  pending: boolean;
  serverError: string | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (item: VerifikasiItem, alasan: string) => void;
}) {
  return (
    <Dialog open={item !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {item ? (
          <RejectForm key={item.arsipId} item={item} pending={pending} serverError={serverError} onCancel={() => onOpenChange(false)} onSubmit={onSubmit} />
        ) : (
          <DialogHeader>
            <DialogTitle>Tolak dokumen</DialogTitle>
          </DialogHeader>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RejectForm({
  item,
  pending,
  serverError,
  onCancel,
  onSubmit,
}: {
  item: VerifikasiItem;
  pending: boolean;
  serverError: string | null;
  onCancel: () => void;
  onSubmit: (item: VerifikasiItem, alasan: string) => void;
}) {
  const id = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [alasan, setAlasan] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const parsed = rejectRequestSchema.shape.alasan.safeParse(alasan);
  const clientError = parsed.success ? null : (parsed.error.issues[0]?.message ?? 'Alasan tidak valid.');
  const error = (submitted ? clientError : null) ?? serverError;
  const length = alasan.trim().length;
  const errorId = `${id}-error`;
  const counterId = `${id}-counter`;
  const helpId = `${id}-help`;

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (!parsed.success) {
      textareaRef.current?.focus();
      return;
    }
    onSubmit(item, parsed.data);
  };

  return (
    <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>Tolak dokumen</DialogTitle>
        <DialogDescription>
          {item.jenisDokumen.nama} milik {item.pegawai.nama}. Alasan dikirim ke pegawai agar dapat mengunggah ulang.
        </DialogDescription>
      </DialogHeader>
      <FieldGroup>
        <Field data-invalid={error ? true : undefined}>
          <FieldLabel htmlFor={`${id}-alasan`}>Alasan penolakan</FieldLabel>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Alasan cepat">
            {REJECT_QUICK_REASONS.map((reason) => (
              <Button
                key={reason}
                type="button"
                size="xs"
                variant="outline"
                disabled={pending}
                onClick={() => {
                  setAlasan((current) => appendReason(current, reason));
                  textareaRef.current?.focus();
                }}
              >
                {reason}
              </Button>
            ))}
          </div>
          <Textarea
            ref={textareaRef}
            id={`${id}-alasan`}
            value={alasan}
            onChange={(event) => setAlasan(event.target.value)}
            maxLength={ALASAN_MAX}
            rows={4}
            autoFocus
            disabled={pending}
            placeholder="Jelaskan apa yang perlu diperbaiki pegawai."
            aria-invalid={error ? true : undefined}
            aria-describedby={[helpId, counterId, error ? errorId : null].filter(Boolean).join(' ')}
          />
          <div className="flex items-start justify-between gap-3">
            <FieldDescription id={helpId}>Minimal 5 karakter.</FieldDescription>
            <span id={counterId} className={cn('shrink-0 text-xs tabular-nums', length > 0 && length < 5 ? 'text-destructive' : 'text-muted-foreground')}>
              {length}/{ALASAN_MAX}
            </span>
          </div>
          {error ? <FieldError id={errorId}>{error}</FieldError> : null}
        </Field>
      </FieldGroup>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
          Batal
        </Button>
        <Button type="submit" variant="destructive" disabled={pending}>
          {pending ? <Spinner data-icon="inline-start" /> : <X data-icon="inline-start" />}
          Tolak dokumen
        </Button>
      </DialogFooter>
    </form>
  );
}
