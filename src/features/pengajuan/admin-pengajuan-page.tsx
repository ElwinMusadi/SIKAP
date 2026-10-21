import { useMemo, useState } from 'react';
import { Check, ChevronRight, FileClock, Inbox, ShieldAlert, TriangleAlert, X } from 'lucide-react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { STATUS_PENGAJUAN, type StatusPengajuan } from '@shared/enums';
import { KEPEGAWAIAN_LABELS, rejectPengajuanRequestSchema, type AdminPengajuanItem, type RefResponse } from '@shared/profile';
import { DataTable, SortableHeader, columnHelper, type DataTableColumn } from '@/components/data-table/data-table';
import { FormDialog } from '@/components/form-patterns';
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
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useMe } from '@/features/auth/queries';
import { PengajuanStatusBadge, PerubahanDiff, perubahanEntries } from '@/features/pengajuan/pengajuan-ui';
import { useAdminPengajuan, useApprovePengajuan, useRefData, useRejectPengajuan } from '@/features/profil/queries';
import { errorMessage, isApiError } from '@/lib/api';
import { formatDateTimeWITA, formatRelative, initials } from '@/lib/format';
import { TONE_CLASSES } from '@/lib/status';
import { cn } from '@/lib/utils';

const CATATAN_MAX = 500;
/** Server returns at most this many rows per status (newest first). */
const LIST_CAP = 100;

const EMPTY_COPY: Record<StatusPengajuan, { title: string; description: string }> = {
  Menunggu: { title: 'Tidak ada pengajuan menunggu', description: 'Semua pengajuan perubahan data sudah ditinjau.' },
  Disetujui: { title: 'Belum ada pengajuan disetujui', description: 'Pengajuan yang Anda setujui akan tampil di sini.' },
  Ditolak: { title: 'Belum ada pengajuan ditolak', description: 'Pengajuan yang Anda tolak akan tampil di sini.' },
  Dibatalkan: { title: 'Belum ada pengajuan dibatalkan', description: 'Pengajuan yang dibatalkan pegawai akan tampil di sini.' },
};

function reviewErrorMessage(error: unknown): string {
  if (isApiError(error, 'CONFLICT')) return 'Pengajuan ini sudah ditinjau atau dibatalkan. Daftar telah dimuat ulang.';
  return errorMessage(error);
}

const col = columnHelper<AdminPengajuanItem>();

/** Changed field names as small chips (max three, then "+n"). */
function ChangedFields({ item }: { item: AdminPengajuanItem }) {
  const fields = perubahanEntries(item.perubahan).map((entry) => KEPEGAWAIAN_LABELS[entry.field]);
  const shown = fields.slice(0, 3);
  return (
    <div className="flex flex-wrap gap-1">
      {shown.map((label) => (
        <Badge key={label} variant="secondary" className="font-normal">
          {label}
        </Badge>
      ))}
      {fields.length > shown.length ? (
        <Badge variant="outline" className="font-normal text-muted-foreground" title={fields.slice(3).join(', ')}>
          +{fields.length - shown.length}
        </Badge>
      ) : null}
    </div>
  );
}

function PegawaiCell({ item }: { item: AdminPengajuanItem }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <Avatar className="size-8 shrink-0">
        <AvatarFallback className="text-xs">{initials(item.pegawai.nama)}</AvatarFallback>
      </Avatar>
      <div className="flex min-w-0 flex-col">
        <span className="truncate font-medium text-foreground">{item.pegawai.nama}</span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {item.pegawai.nip}
          {item.pegawai.statusKepegawaian ? ` · ${item.pegawai.statusKepegawaian}` : ''}
        </span>
      </div>
    </div>
  );
}

function StaleBadge() {
  return (
    <Badge variant="outline" className={TONE_CLASSES.pending.badge} title="Data pegawai sudah berubah sejak pengajuan dibuat">
      <TriangleAlert data-icon="inline-start" aria-hidden="true" />
      Data berubah
    </Badge>
  );
}

export default function AdminPengajuanPage() {
  const [status, setStatus] = useState<StatusPengajuan>('Menunggu');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const query = useAdminPengajuan(status);
  const refQuery = useRefData();
  const counts = query.data?.counts;
  const loading = query.isPending || query.isPlaceholderData;
  const { data: me } = useMe();
  const items = loading ? undefined : query.data?.items;
  const selected = items?.find((item) => item.id === selectedId) ?? null;

  const columns = useMemo<DataTableColumn<AdminPengajuanItem>[]>(
    () => [
      col.accessor((row) => row.pegawai.nama, {
        id: 'pegawai',
        header: ({ column }) => <SortableHeader column={column} title="Pegawai" />,
        cell: ({ row }) => <PegawaiCell item={row.original} />,
      }),
      col.display({
        id: 'perubahan',
        header: 'Data yang diubah',
        meta: { cellClassName: 'whitespace-normal' },
        cell: ({ row }) => <ChangedFields item={row.original} />,
      }),
      col.accessor('createdAt', {
        id: 'createdAt',
        header: ({ column }) => <SortableHeader column={column} title="Diajukan" />,
        sortFn: 'datetime',
        meta: { headerClassName: 'hidden lg:table-cell', cellClassName: 'hidden lg:table-cell' },
        cell: (info) => (
          <time dateTime={info.getValue()} title={formatDateTimeWITA(info.getValue())} className="text-sm text-muted-foreground">
            {formatRelative(info.getValue())}
          </time>
        ),
      }),
      col.accessor('status', {
        header: 'Status',
        cell: ({ row }) => (
          <div className="flex flex-wrap items-center gap-1.5">
            <PengajuanStatusBadge status={row.original.status} />
            {row.original.stale && row.original.status === 'Menunggu' ? <StaleBadge /> : null}
          </div>
        ),
      }),
      col.display({
        id: 'aksi',
        header: () => <span className="sr-only">Aksi</span>,
        meta: { headerClassName: 'w-28', cellClassName: 'text-right' },
        cell: ({ row }) => (
          <Button
            size="sm"
            variant={row.original.status === 'Menunggu' ? 'outline' : 'ghost'}
            onClick={(event) => {
              event.stopPropagation();
              setSelectedId(row.original.id);
            }}
          >
            {row.original.status === 'Menunggu' ? 'Tinjau' : 'Lihat'}
            <ChevronRight data-icon="inline-end" />
          </Button>
        ),
      }),
    ],
    [],
  );

  const table = (
    <div className="flex flex-col gap-3">
      <DataTable
        label={`Pengajuan ${status.toLowerCase()}`}
        data={items}
        columns={columns}
        getRowId={(row) => String(row.id)}
        loading={loading}
        error={query.isError ? query.error : undefined}
        onRetry={() => void query.refetch()}
        empty={{ icon: Inbox, ...EMPTY_COPY[status] }}
        onRowClick={(row) => setSelectedId(row.id)}
        mobileCard={(item) => (
          <button
            type="button"
            onClick={() => setSelectedId(item.id)}
            className="flex w-full flex-col gap-3 rounded-xl border bg-card p-4 text-left shadow-card outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <div className="flex items-start justify-between gap-3">
              <PegawaiCell item={item} />
              <PengajuanStatusBadge status={item.status} className="shrink-0" />
            </div>
            <ChangedFields item={item} />
            <span className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              Diajukan {formatRelative(item.createdAt)}
              {item.stale && item.status === 'Menunggu' ? <StaleBadge /> : null}
            </span>
          </button>
        )}
      />
      {status !== 'Menunggu' && (items?.length ?? 0) >= LIST_CAP ? (
        <p className="text-center text-sm text-muted-foreground">Menampilkan {LIST_CAP} pengajuan terbaru.</p>
      ) : null}
    </div>
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Pengajuan Perubahan Data" description="Tinjau pengajuan perubahan data kepegawaian dari pegawai." />

      <Tabs
        value={status}
        onValueChange={(value) => {
          setStatus(value as StatusPengajuan);
          setSelectedId(null);
        }}
        className="gap-4"
      >
        <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <TabsList>
            {STATUS_PENGAJUAN.map((s) => (
              <TabsTrigger key={s} value={s} className="gap-1.5 px-3">
                {s}
                {counts ? (
                  <span
                    className={cn(
                      'rounded-full px-1.5 text-xs tabular-nums',
                      s === 'Menunggu' && counts[s] > 0 ? 'bg-status-pending-muted font-medium text-status-pending' : 'bg-muted text-muted-foreground',
                    )}
                  >
                    {counts[s]}
                  </span>
                ) : null}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        {/* One panel per tab so every trigger's aria-controls resolves; only the active one has content. */}
        {STATUS_PENGAJUAN.map((s) => (
          <TabsContent key={s} value={s} forceMount className="data-[state=inactive]:hidden">
            {s === status ? table : null}
          </TabsContent>
        ))}
      </Tabs>

      <ReviewSheet
        item={selected}
        refData={refQuery.data}
        isOwn={selected !== null && me?.id === selected.pegawai.id}
        onOpenChange={(open) => !open && setSelectedId(null)}
        onDone={() => setSelectedId(null)}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Review sheet                                                        */
/* ------------------------------------------------------------------ */

function ReviewSheet({
  item,
  refData,
  isOwn,
  onOpenChange,
  onDone,
}: {
  item: AdminPengajuanItem | null;
  refData: RefResponse | undefined;
  isOwn: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const [approveOpen, setApproveOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const pending = item?.status === 'Menunggu';

  return (
    <Sheet open={item !== null} onOpenChange={onOpenChange}>
      {/* Same data-[side] variants as the base classes, otherwise the default w-3/4 wins on phones. */}
      <SheetContent side="right" className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-xl">
        {item ? (
          <>
            <SheetHeader className="gap-3 border-b pr-12">
              <div className="flex items-center gap-3">
                <Avatar className="size-10 shrink-0">
                  <AvatarFallback>{initials(item.pegawai.nama)}</AvatarFallback>
                </Avatar>
                <div className="flex min-w-0 flex-col gap-0.5">
                  <SheetTitle className="truncate text-base">{item.pegawai.nama}</SheetTitle>
                  <SheetDescription className="tabular-nums">
                    NIP {item.pegawai.nip}
                    {item.pegawai.statusKepegawaian ? ` · ${item.pegawai.statusKepegawaian}` : ''}
                  </SheetDescription>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <PengajuanStatusBadge status={item.status} />
                <span className="text-xs text-muted-foreground" title={formatDateTimeWITA(item.createdAt)}>
                  Diajukan {formatRelative(item.createdAt)} · {formatDateTimeWITA(item.createdAt)}
                </span>
              </div>
            </SheetHeader>

            <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4">
              {item.stale && pending ? (
                <Alert variant="pending">
                  <TriangleAlert aria-hidden="true" />
                  <AlertTitle>Data pegawai sudah berubah sejak pengajuan dibuat</AlertTitle>
                  <AlertDescription>Periksa kolom data lama sebelum menyetujui.</AlertDescription>
                </Alert>
              ) : null}

              {item.alasan ? (
                <section className="flex flex-col gap-1.5">
                  <h3 className="text-eyebrow text-muted-foreground uppercase">Alasan pegawai</h3>
                  <p className="rounded-lg bg-muted/40 px-3 py-2 text-sm whitespace-pre-line text-foreground">{item.alasan}</p>
                </section>
              ) : null}

              <section className="flex flex-col gap-3">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-h3">Perubahan</h3>
                  <span className="text-xs text-muted-foreground">Data lama → diajukan</span>
                </div>
                <PerubahanDiff perubahan={item.perubahan} refData={refData} />
              </section>

              {item.reviewedAt ? (
                <Alert>
                  <FileClock aria-hidden="true" />
                  <AlertTitle>
                    {item.status === 'Dibatalkan'
                      ? `Dibatalkan pegawai pada ${formatDateTimeWITA(item.reviewedAt)}`
                      : `Ditinjau${item.reviewedBy ? ` oleh ${item.reviewedBy.nama}` : ''} pada ${formatDateTimeWITA(item.reviewedAt)}`}
                  </AlertTitle>
                  {item.catatanAdmin ? (
                    <AlertDescription>
                      <span className="font-medium text-foreground">Catatan:</span> {item.catatanAdmin}
                    </AlertDescription>
                  ) : null}
                </Alert>
              ) : null}

              <Link
                to={`/admin/pegawai/${item.pegawai.id}`}
                className="w-fit rounded-sm text-sm text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
              >
                Buka data pegawai
              </Link>
            </div>

            {pending ? (
              <SheetFooter className="border-t bg-muted/40">
                {isOwn ? (
                  <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <ShieldAlert className="size-4 shrink-0" aria-hidden="true" />
                    Pengajuan Anda sendiri harus diverifikasi admin lain.
                  </p>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      variant="outline"
                      className="border-destructive/40 bg-card text-destructive hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => setRejectOpen(true)}
                    >
                      <X data-icon="inline-start" />
                      Tolak
                    </Button>
                    <Button variant="success" onClick={() => setApproveOpen(true)}>
                      <Check data-icon="inline-start" />
                      Setujui
                    </Button>
                  </div>
                )}
              </SheetFooter>
            ) : null}

            <ApproveDialog item={item} open={approveOpen} onOpenChange={setApproveOpen} onDone={onDone} />
            <RejectDialog item={item} open={rejectOpen} onOpenChange={setRejectOpen} onDone={onDone} />
          </>
        ) : (
          <SheetHeader>
            <SheetTitle>Tinjau pengajuan</SheetTitle>
          </SheetHeader>
        )}
      </SheetContent>
    </Sheet>
  );
}

function ApproveDialog({
  item,
  open,
  onOpenChange,
  onDone,
}: {
  item: AdminPengajuanItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const approve = useApprovePengajuan();
  const [catatan, setCatatan] = useState('');

  const confirm = (event: React.MouseEvent) => {
    event.preventDefault();
    approve.mutate(
      { id: item.id, catatan: catatan.trim() || undefined },
      {
        onSuccess: () => {
          toast.success(`Pengajuan ${item.pegawai.nama} disetujui. Data kepegawaian telah diperbarui.`);
          onOpenChange(false);
          onDone();
        },
        onError: (error) => {
          toast.error(reviewErrorMessage(error));
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (approve.isPending) return;
        onOpenChange(next);
        if (next) setCatatan('');
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Setujui pengajuan ini?</AlertDialogTitle>
          <AlertDialogDescription>
            Data kepegawaian {item.pegawai.nama} akan langsung diperbarui sesuai nilai yang diajukan.
            {item.stale ? ' Perhatian: data pegawai sudah berubah sejak pengajuan dibuat.' : ''}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Field>
          <FieldLabel htmlFor={`approve-catatan-${item.id}`}>Catatan (opsional)</FieldLabel>
          <Textarea id={`approve-catatan-${item.id}`} rows={2} maxLength={CATATAN_MAX} value={catatan} onChange={(event) => setCatatan(event.target.value)} />
        </Field>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={approve.isPending}>Batal</AlertDialogCancel>
          <AlertDialogAction variant="success" disabled={approve.isPending} onClick={confirm}>
            {approve.isPending ? <Spinner data-icon="inline-start" /> : <Check data-icon="inline-start" />}
            Setujui
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function RejectDialog({
  item,
  open,
  onOpenChange,
  onDone,
}: {
  item: AdminPengajuanItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const reject = useRejectPengajuan();
  const [catatan, setCatatan] = useState('');
  const [error, setError] = useState<string | null>(null);
  const fieldId = `reject-catatan-${item.id}`;
  const formId = `reject-form-${item.id}`;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const parsed = rejectPengajuanRequestSchema.safeParse({ catatan });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Catatan tidak valid.');
      return;
    }
    setError(null);
    reject.mutate(
      { id: item.id, catatan: parsed.data.catatan },
      {
        onSuccess: () => {
          toast.success(`Pengajuan ${item.pegawai.nama} ditolak.`);
          onOpenChange(false);
          onDone();
        },
        onError: (err) => {
          if (isApiError(err, 'VALIDATION_ERROR') && err.fields?.catatan) {
            setError(err.fields.catatan);
            return;
          }
          toast.error(reviewErrorMessage(err));
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        if (reject.isPending) return;
        onOpenChange(next);
        if (next) {
          setCatatan('');
          setError(null);
        }
      }}
      title="Tolak pengajuan"
      description={`Catatan akan ditampilkan kepada ${item.pegawai.nama} sebagai alasan penolakan.`}
      footer={
        <>
          <Button variant="outline" disabled={reject.isPending} onClick={() => onOpenChange(false)}>
            Batal
          </Button>
          <Button type="submit" form={formId} variant="destructive" disabled={reject.isPending}>
            {reject.isPending ? <Spinner data-icon="inline-start" /> : <X data-icon="inline-start" />}
            Tolak pengajuan
          </Button>
        </>
      }
    >
      <form id={formId} noValidate onSubmit={submit}>
        <Field data-invalid={error ? true : undefined}>
          <FieldLabel htmlFor={fieldId}>Catatan penolakan</FieldLabel>
          <Textarea
            id={fieldId}
            rows={4}
            maxLength={CATATAN_MAX}
            value={catatan}
            autoFocus
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${fieldId}-counter ${fieldId}-error` : `${fieldId}-counter`}
            onChange={(event) => {
              setCatatan(event.target.value);
              if (error) setError(null);
            }}
          />
          <FieldDescription id={`${fieldId}-counter`} className="flex justify-between">
            <span>Minimal 5 karakter.</span>
            <span className="tabular-nums">
              {catatan.length}/{CATATAN_MAX}
            </span>
          </FieldDescription>
          <FieldError id={`${fieldId}-error`}>{error}</FieldError>
        </Field>
      </form>
    </FormDialog>
  );
}
