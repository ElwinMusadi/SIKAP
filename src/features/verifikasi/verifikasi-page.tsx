import { useEffect, useEffectEvent, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  Check,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  Clock,
  Download,
  ExternalLink,
  FileText,
  Inbox,
  RotateCcw,
  ShieldAlert,
  X,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from 'lucide-react';
import { Link, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { documentFileUrl, isViewableDocumentMime } from '@shared/dokumen';
import { rejectRequestSchema, type DecisionResponse, type VerifikasiItem } from '@shared/verifikasi';
import { PageHeader } from '@/components/page-header';
import { EmptyState, ErrorState } from '@/components/states';
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
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Kbd } from '@/components/ui/kbd';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useMe } from '@/features/auth/queries';
import { fileKind, formatBytes } from '@/features/dokumen/dokumen-utils';
import { useRefData } from '@/features/profil/queries';
import { errorMessage, isApiError } from '@/lib/api';
import { formatDateTimeWITA, formatRelative, initials } from '@/lib/format';
import { TONE_CLASSES } from '@/lib/status';
import { cn } from '@/lib/utils';
import { isStaleDecisionError, useApprove, useDecisionPending, useReject, useVerifikasiQueue } from './queries';
import {
  ALASAN_MAX,
  REJECT_QUICK_REASONS,
  WAIT_WARN_DAYS,
  appendReason,
  compactWait,
  flattenQueue,
  neighborId,
  parseArsipParam,
  shortcutAction,
  waitingDays,
} from './verifikasi-utils';

const ALL = 'all';
const DESKTOP_QUERY = '(min-width: 1024px)';

/*
 * Workspace (docs/RENCANA-REDESIGN-UIUX.md §8): xl+ = antrean | pratinjau | keputusan;
 * lg = pratinjau | (keputusan over antrean); below lg = antrean list + full sheet.
 */
const WORKSPACE_GRID =
  'grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_20rem] xl:grid-cols-[16.5rem_minmax(0,1fr)_20rem] 2xl:grid-cols-[18rem_minmax(0,1fr)_22rem]';
const AREA = {
  queue: 'min-w-0 lg:col-start-2 lg:row-start-2 xl:col-start-1 xl:row-start-1',
  preview: 'min-w-0 lg:sticky lg:top-20 lg:col-start-1 lg:row-span-2 lg:row-start-1 xl:col-start-2 xl:row-span-1',
  decision: 'min-w-0 lg:col-start-2 lg:row-start-1 xl:col-start-3',
};
const VIEWER_HEIGHT = 'h-[60svh] lg:h-[calc(100svh-13rem)] lg:min-h-[30rem]';

function subscribeDesktop(onChange: () => void) {
  const mql = window.matchMedia(DESKTOP_QUERY);
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}

/** lg+ (workspace layout). Only one layout is mounted so the preview iframe never loads twice. */
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

  // Deep link from Beranda / detail pegawai: ?arsip=<id> selects that document once, then leaves the URL.
  const arsipParam = searchParams.get('arsip');
  const [handledArsip, setHandledArsip] = useState<string | null>(null);
  if (arsipParam !== handledArsip) {
    // Adjust state during render (no effect round-trip); the effect below only cleans the URL.
    setHandledArsip(arsipParam);
    const fromUrl = parseArsipParam(arsipParam);
    if (fromUrl !== null) setSelectedId(fromUrl);
  }
  useEffect(() => {
    if (arsipParam === null) return;
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('arsip');
        return next;
      },
      { replace: true },
    );
  }, [arsipParam, setSearchParams]);

  const items = useMemo(() => flattenQueue(queue.data), [queue.data]);
  const firstPage = queue.data?.pages[0];
  const total = firstPage?.total ?? 0;
  const shownTotal = jenis ? (firstPage?.perJenis[jenis] ?? items.length) : total;
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
      <SelectTrigger className="w-full" aria-label="Filter jenis dokumen">
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
    body = <WorkspaceSkeleton isDesktop={isDesktop} />;
  } else if (queue.isError) {
    body = (
      <Card className="py-0">
        <ErrorState
          error={queue.error}
          title="Gagal memuat antrean verifikasi"
          onRetry={() => void queue.refetch()}
          retrying={queue.isFetching}
          size="page"
        />
      </Card>
    );
  } else if (items.length === 0) {
    const filtered = jenis !== null && total > 0;
    body = (
      <Card className="py-0">
        <EmptyState
          icon={filtered ? Inbox : CheckCheck}
          size="page"
          title={filtered ? 'Tidak ada dokumen untuk jenis ini' : 'Antrean kosong'}
          description={
            filtered ? `Masih ada ${total} dokumen lain yang menunggu verifikasi.` : 'Semua dokumen sudah diperiksa.'
          }
          action={
            filtered ? (
              <Button variant="outline" onClick={() => changeJenis(ALL)}>
                Tampilkan semua jenis
              </Button>
            ) : undefined
          }
        />
      </Card>
    );
  } else {
    const queuePanel = (
      <QueuePanel
        count={shownTotal}
        filter={filter}
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
      <div className={WORKSPACE_GRID}>
        <section aria-label="Antrean verifikasi" className={AREA.queue}>
          {queuePanel}
        </section>
        <section aria-label="Pratinjau dokumen" className={AREA.preview}>
          {selected ? <DocumentPreview key={`${selected.arsipId}-${selected.versi}`} item={selected} /> : null}
        </section>
        <section aria-label="Keputusan verifikasi" className={AREA.decision}>
          {selected ? (
            <Card className="gap-0 py-0">
              <div className="flex items-center justify-between gap-2 border-b py-2 pr-2 pl-4">
                <p className="text-eyebrow text-muted-foreground uppercase tabular-nums">
                  Dokumen {selectedIndex + 1} dari {shownTotal}
                </p>
                <div className="flex gap-0.5">
                  <NavButton icon={ChevronLeft} label="Dokumen sebelumnya" shortcut="K" onClick={() => step(-1)} disabled={selectedIndex <= 0} />
                  <NavButton
                    icon={ChevronRight}
                    label="Dokumen berikutnya"
                    shortcut="J"
                    onClick={() => step(1)}
                    disabled={selectedIndex >= items.length - 1 && !queue.hasNextPage}
                  />
                </div>
              </div>
              <div className="p-4">
                <ItemDetails item={selected} />
              </div>
              <div
                ref={actionsRef}
                tabIndex={-1}
                role="group"
                aria-label="Tindakan verifikasi"
                className="border-t bg-muted/40 p-4 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              >
                {actions(selected)}
              </div>
            </Card>
          ) : null}
        </section>
      </div>
    ) : (
      <>
        <section aria-label="Antrean verifikasi">{queuePanel}</section>
        <Sheet open={explicit !== null} onOpenChange={(open) => !open && !decisionPending && setSelectedId(null)}>
          <SheetContent
            side="right"
            className="w-full gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-xl"
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
                  <DocumentPreview key={`${explicit.arsipId}-${explicit.versi}`} item={explicit} />
                  <ItemDetails item={explicit} />
                </div>
                <SheetFooter className="border-t bg-muted/40">
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

  const oldest = jenis === null ? items[0] : undefined;
  let description: string;
  if (queue.isPending) description = 'Memuat antrean…';
  else if (total === 0) description = 'Tidak ada dokumen yang menunggu verifikasi.';
  else description = `${total} dokumen menunggu verifikasi${oldest ? ` · terlama diunggah ${formatRelative(oldest.uploadedAt)}` : ''}.`;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Verifikasi Dokumen" description={description} />
      {body}

      <ApproveDialog
        item={confirmItem}
        pending={approve.isPending}
        continues={items.length > 1}
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

function NavButton({
  icon: Icon,
  label,
  shortcut,
  onClick,
  disabled,
}: {
  icon: LucideIcon;
  label: string;
  shortcut: string;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button size="icon-sm" variant="ghost" onClick={onClick} disabled={disabled} aria-label={label} aria-keyshortcuts={shortcut}>
          <Icon />
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {label} <Kbd>{shortcut}</Kbd>
      </TooltipContent>
    </Tooltip>
  );
}

/* ------------------------------------------------------------------ */
/* Queue                                                               */
/* ------------------------------------------------------------------ */

function QueuePanel({
  count,
  filter,
  items,
  selectedId,
  onSelect,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  busy,
}: {
  count: number;
  filter: ReactNode;
  items: VerifikasiItem[];
  selectedId: number | null;
  onSelect: (item: VerifikasiItem) => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
  busy: boolean;
}) {
  return (
    <Card className="gap-0 py-0" aria-busy={busy || undefined}>
      <div className="flex flex-col gap-3 border-b p-4">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-h3">Antrean</h2>
          <span className="text-xs text-muted-foreground tabular-nums">{count} menunggu</span>
        </div>
        {filter}
        <p className="text-xs text-muted-foreground">Diurutkan dari unggahan paling lama.</p>
      </div>
      <ul className={cn('divide-y lg:max-h-80 lg:overflow-y-auto xl:max-h-[calc(100svh-19rem)] xl:min-h-[16rem]', busy && 'opacity-60')}>
        {items.map((item) => (
          <QueueRow key={item.arsipId} item={item} active={item.arsipId === selectedId} onSelect={onSelect} />
        ))}
      </ul>
      {hasNextPage ? (
        <div className="border-t p-2">
          <Button variant="ghost" size="sm" onClick={onLoadMore} disabled={isFetchingNextPage} className="w-full">
            {isFetchingNextPage ? <Spinner data-icon="inline-start" /> : null}
            Muat lebih banyak
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

function QueueRow({ item, active, onSelect }: { item: VerifikasiItem; active: boolean; onSelect: (item: VerifikasiItem) => void }) {
  const late = waitingDays(item.uploadedAt) >= WAIT_WARN_DAYS;
  return (
    <li>
      <button
        id={`antrean-${item.arsipId}`}
        type="button"
        onClick={() => onSelect(item)}
        aria-current={active ? 'true' : undefined}
        className={cn(
          'relative flex w-full items-center gap-3 px-4 py-3 text-left transition-colors outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset motion-reduce:transition-none',
          active && 'bg-accent-soft before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-primary hover:bg-accent-soft',
        )}
      >
        <Avatar className="size-8 shrink-0">
          {item.pegawai.fotoUrl ? <AvatarImage src={item.pegawai.fotoUrl} alt="" /> : null}
          <AvatarFallback className="text-xs">{initials(item.pegawai.nama)}</AvatarFallback>
        </Avatar>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className={cn('truncate text-sm font-medium', active && 'text-primary')}>{item.pegawai.nama}</span>
          <span className="truncate text-xs text-muted-foreground">{item.jenisDokumen.nama}</span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1">
          <time
            dateTime={item.uploadedAt}
            title={`Diunggah ${formatDateTimeWITA(item.uploadedAt)}`}
            className={cn('inline-flex items-center gap-1 text-xs tabular-nums', late ? 'font-medium text-status-pending' : 'text-muted-foreground')}
          >
            {late ? <Clock className="size-3" aria-hidden="true" /> : null}
            {compactWait(item.uploadedAt)}
            <span className="sr-only"> menunggu</span>
          </time>
          {item.isReupload ? (
            <Badge variant="outline" className={cn('h-5 px-1.5 text-[0.7rem]', TONE_CLASSES.pending.badge)}>
              Ulang
            </Badge>
          ) : null}
        </span>
      </button>
    </li>
  );
}

/* ------------------------------------------------------------------ */
/* Details + actions                                                   */
/* ------------------------------------------------------------------ */

function ItemDetails({ item }: { item: VerifikasiItem }) {
  const headingId = useId();
  const { pegawai, jenisDokumen, file } = item;
  const late = waitingDays(item.uploadedAt) >= WAIT_WARN_DAYS;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-3">
        <Avatar className="size-10 shrink-0">
          {pegawai.fotoUrl ? <AvatarImage src={pegawai.fotoUrl} alt="" /> : null}
          <AvatarFallback>{initials(pegawai.nama)}</AvatarFallback>
        </Avatar>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <Link
            to={`/admin/pegawai/${pegawai.id}`}
            className="w-fit rounded-sm font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            {pegawai.nama}
          </Link>
          <p className="text-xs text-muted-foreground tabular-nums">NIP {pegawai.nip}</p>
          {pegawai.jabatan || pegawai.unit ? (
            <p className="text-xs text-muted-foreground">{[pegawai.jabatan, pegawai.unit].filter(Boolean).join(' · ')}</p>
          ) : null}
          {pegawai.statusKepegawaian ? (
            <Badge variant="secondary" className="mt-1 w-fit">
              {pegawai.statusKepegawaian}
            </Badge>
          ) : null}
        </div>
      </div>

      <Separator />

      <section aria-labelledby={headingId} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <p className="text-eyebrow text-muted-foreground uppercase">{jenisDokumen.kategori}</p>
          <h2 id={headingId} className="text-h3">
            {jenisDokumen.nama}
          </h2>
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusBadge domain="dokumen" status="Menunggu" />
            <Badge variant="outline">{jenisDokumen.wajib ? 'Wajib' : 'Opsional'}</Badge>
          </div>
        </div>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
          <dt className="text-muted-foreground">File</dt>
          <dd className="break-all">
            {file.fileName} <span className="text-muted-foreground">· {formatBytes(file.sizeBytes)}</span>
          </dd>
          <dt className="text-muted-foreground">Diunggah</dt>
          <dd>{formatDateTimeWITA(item.uploadedAt)}</dd>
          <dt className="text-muted-foreground">Menunggu</dt>
          <dd className={cn('tabular-nums', late && 'font-medium text-status-pending')}>{compactWait(item.uploadedAt)}</dd>
        </dl>
      </section>

      {item.isReupload ? (
        <div className="flex gap-2.5 rounded-lg border border-status-pending/25 bg-status-pending-muted p-3 text-sm">
          <RotateCcw className="mt-0.5 size-4 shrink-0 text-status-pending" aria-hidden="true" />
          <div className="flex flex-col gap-1">
            <p className="font-medium text-status-pending">Unggahan ulang</p>
            {item.catatanSebelumnya ? (
              <p className="text-foreground">
                <span className="text-muted-foreground">Alasan penolakan sebelumnya: </span>“{item.catatanSebelumnya}”
              </p>
            ) : (
              <p className="text-muted-foreground">Dokumen ini sudah pernah diperiksa sebelumnya.</p>
            )}
          </div>
        </div>
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
          className="border-destructive/40 bg-card text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={onReject}
          disabled={own || pending}
          aria-keyshortcuts={showShortcuts ? 'R' : undefined}
        >
          <X data-icon="inline-start" />
          Tolak
          {showShortcuts ? (
            <Kbd aria-hidden="true" className="bg-destructive/10 text-current">
              R
            </Kbd>
          ) : null}
        </Button>
        <Button variant="success" onClick={onApprove} disabled={own || pending} aria-keyshortcuts={showShortcuts ? 'A' : undefined}>
          {pending ? <Spinner data-icon="inline-start" /> : <Check data-icon="inline-start" />}
          Setujui
          {showShortcuts ? (
            <Kbd aria-hidden="true" className="bg-white/20 text-current dark:bg-black/15">
              A
            </Kbd>
          ) : null}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {showShortcuts ? (
          <>
            <Kbd>J</Kbd> <Kbd>K</Kbd> pindah dokumen.{' '}
          </>
        ) : null}
        Setelah keputusan, dokumen berikutnya terbuka otomatis.
      </p>
      <span className="sr-only">
        {item.jenisDokumen.nama}, {item.pegawai.nama}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Preview                                                             */
/* ------------------------------------------------------------------ */

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.25;

function ToolbarLink({ href, label, icon: Icon, download }: { href: string; label: string; icon: LucideIcon; download?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button asChild size="icon-sm" variant="ghost">
          {download ? (
            <a href={href} rel="noopener" download aria-label={label}>
              <Icon />
            </a>
          ) : (
            <a href={href} target="_blank" rel="noopener noreferrer" aria-label={`${label} (tab baru)`}>
              <Icon />
            </a>
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function DocumentPreview({ item }: { item: VerifikasiItem }) {
  const [zoom, setZoom] = useState(1);
  const src = documentFileUrl(item.arsipId);
  const downloadUrl = documentFileUrl(item.arsipId, { download: true });
  const kind = isViewableDocumentMime(item.file.mimeType) ? fileKind(item.file.mimeType) : 'other';

  let viewer: ReactNode;
  if (kind === 'pdf') {
    viewer = (
      <iframe
        src={src}
        title={`Pratinjau ${item.jenisDokumen.nama} — ${item.pegawai.nama}`}
        className={cn('block w-full border-0 bg-muted', VIEWER_HEIGHT)}
        referrerPolicy="no-referrer"
      />
    );
  } else if (kind === 'image') {
    viewer = (
      <div className={cn('flex overflow-auto bg-muted/50 p-3', VIEWER_HEIGHT)}>
        <img
          src={src}
          alt={`${item.jenisDokumen.nama} milik ${item.pegawai.nama}`}
          referrerPolicy="no-referrer"
          className={cn('m-auto rounded-sm object-contain shadow-card', zoom === 1 ? 'max-h-full max-w-full' : 'max-w-none')}
          style={zoom === 1 ? undefined : { width: `${zoom * 100}%` }}
        />
      </div>
    );
  } else {
    viewer = (
      <EmptyState
        icon={FileText}
        title="Pratinjau tidak tersedia"
        description="Jenis file ini tidak dapat ditampilkan di browser. Unduh file untuk memeriksanya."
        action={
          <Button asChild size="sm" variant="outline">
            <a href={downloadUrl} rel="noopener" download>
              <Download data-icon="inline-start" />
              Unduh
            </a>
          </Button>
        }
        className="bg-muted/30"
      />
    );
  }

  return (
    // shrink-0: inside the mobile sheet's scrolling flex column an overflow-hidden card would collapse.
    <Card className="shrink-0 gap-0 py-0">
      <div className="flex min-h-12 flex-wrap items-center gap-2 border-b py-1.5 pr-1.5 pl-3">
        <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <p className="min-w-0 flex-1 truncate text-sm font-medium" title={item.file.fileName}>
          {item.file.fileName}
          <span className="font-normal text-muted-foreground"> · {formatBytes(item.file.sizeBytes)}</span>
        </p>
        <div className="flex items-center gap-0.5">
          {kind === 'image' ? (
            <div className="mr-1 flex items-center gap-0.5 border-r pr-1" role="group" aria-label="Perbesaran gambar">
              <Button size="icon-sm" variant="ghost" onClick={() => setZoom((z) => Math.max(ZOOM_MIN, z - ZOOM_STEP))} disabled={zoom <= ZOOM_MIN} aria-label="Perkecil">
                <ZoomOut />
              </Button>
              <button
                type="button"
                onClick={() => setZoom(1)}
                disabled={zoom === 1}
                className="w-12 rounded-md text-center text-xs text-muted-foreground tabular-nums outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none"
                aria-label={`Perbesaran ${Math.round(zoom * 100)} persen, klik untuk mengatur ulang`}
              >
                <span aria-live="polite">{Math.round(zoom * 100)}%</span>
              </button>
              <Button size="icon-sm" variant="ghost" onClick={() => setZoom((z) => Math.min(ZOOM_MAX, z + ZOOM_STEP))} disabled={zoom >= ZOOM_MAX} aria-label="Perbesar">
                <ZoomIn />
              </Button>
            </div>
          ) : null}
          <ToolbarLink href={downloadUrl} label="Unduh" icon={Download} download />
          {kind !== 'other' ? <ToolbarLink href={src} label="Buka di tab baru" icon={ExternalLink} /> : null}
        </div>
      </div>
      {viewer}
    </Card>
  );
}

function WorkspaceSkeleton({ isDesktop }: { isDesktop: boolean }) {
  const rows = (
    <div className="flex flex-col gap-2">
      {[0, 1, 2, 3, 4].map((i) => (
        <Skeleton key={i} className="h-14 w-full" />
      ))}
    </div>
  );
  if (!isDesktop) {
    return (
      <div aria-busy="true" aria-label="Memuat antrean">
        {rows}
      </div>
    );
  }
  return (
    <div className={WORKSPACE_GRID} aria-busy="true" aria-label="Memuat antrean">
      <div className={AREA.queue}>{rows}</div>
      <Skeleton className={cn(AREA.preview, 'h-[calc(100svh-13rem)] min-h-[30rem] w-full')} />
      <Skeleton className={cn(AREA.decision, 'h-96 w-full')} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Dialogs                                                             */
/* ------------------------------------------------------------------ */

function ApproveDialog({
  item,
  pending,
  continues,
  onOpenChange,
  onConfirm,
}: {
  item: VerifikasiItem | null;
  pending: boolean;
  /** Another document is left in the queue: the label says the next one opens after approving. */
  continues: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (item: VerifikasiItem) => void;
}) {
  const actionRef = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog open={item !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent
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
            variant="success"
            disabled={pending}
            onClick={(event) => {
              event.preventDefault();
              if (item) onConfirm(item);
            }}
          >
            {pending ? <Spinner data-icon="inline-start" /> : <Check data-icon="inline-start" />}
            {continues ? 'Setujui & lanjutkan' : 'Setujui'}
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
