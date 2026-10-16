import { useState } from 'react';
import { Check, Inbox, RefreshCw, TriangleAlert, X } from 'lucide-react';
import { toast } from 'sonner';
import { STATUS_PENGAJUAN, type StatusPengajuan } from '@shared/enums';
import { rejectPengajuanRequestSchema, type AdminPengajuanItem, type RefResponse } from '@shared/profile';
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
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useMe } from '@/features/auth/queries';
import { Textarea } from '@/components/ui/textarea';
import { PengajuanStatusBadge, PerubahanTable } from '@/features/pengajuan/pengajuan-ui';
import { useAdminPengajuan, useApprovePengajuan, useRefData, useRejectPengajuan } from '@/features/profil/queries';
import { errorMessage, isApiError } from '@/lib/api';
import { formatDateTimeWITA, formatRelative } from '@/lib/format';

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

export default function AdminPengajuanPage() {
  const [status, setStatus] = useState<StatusPengajuan>('Menunggu');
  const query = useAdminPengajuan(status);
  const refQuery = useRefData();
  const counts = query.data?.counts;
  const showSkeleton = query.isPending || query.isPlaceholderData;
  const { data: me } = useMe();

  const panel = showSkeleton ? (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Memuat pengajuan">
      {[0, 1].map((i) => (
        <Card key={i}>
          <CardHeader>
            <Skeleton className="h-5 w-56" />
            <Skeleton className="h-4 w-40" />
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Skeleton className="h-4 w-full max-w-lg" />
            <Skeleton className="h-24 w-full" />
          </CardContent>
        </Card>
      ))}
    </div>
  ) : query.isError ? (
    <Alert variant="destructive" role="alert">
      <TriangleAlert />
      <AlertTitle>Gagal memuat pengajuan</AlertTitle>
      <AlertDescription>
        <p>{errorMessage(query.error)}</p>
        <Button size="sm" variant="outline" className="mt-2" onClick={() => void query.refetch()}>
          <RefreshCw data-icon="inline-start" />
          Coba lagi
        </Button>
      </AlertDescription>
    </Alert>
  ) : query.data.items.length === 0 ? (
    <Empty className="border border-dashed">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Inbox />
        </EmptyMedia>
        <EmptyTitle>{EMPTY_COPY[status].title}</EmptyTitle>
        <EmptyDescription>{EMPTY_COPY[status].description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  ) : (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col gap-4">
        {query.data.items.map((item) => (
          <li key={item.id}>
            <PengajuanCard item={item} refData={refQuery.data} isOwn={me?.id === item.pegawai.id} />
          </li>
        ))}
      </ul>
      {status !== 'Menunggu' && query.data.items.length >= LIST_CAP ? (
        <p className="text-center text-sm text-muted-foreground">Menampilkan {LIST_CAP} pengajuan terbaru.</p>
      ) : null}
    </div>
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Pengajuan Perubahan Data"
        description="Tinjau pengajuan perubahan data kepegawaian dari pegawai."
      />

      <Tabs value={status} onValueChange={(value) => setStatus(value as StatusPengajuan)} className="gap-6">
        <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <TabsList>
            {STATUS_PENGAJUAN.map((s) => (
              <TabsTrigger key={s} value={s} className="px-3">
                {s}
                {counts ? (
                  <Badge variant={s === 'Menunggu' && counts[s] > 0 ? 'default' : 'secondary'} className="tabular-nums">
                    {counts[s]}
                  </Badge>
                ) : null}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        {/* One panel per tab so every trigger's aria-controls resolves; only the active one has content. */}
        {STATUS_PENGAJUAN.map((s) => (
          <TabsContent key={s} value={s}>
            {s === status ? panel : null}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

function PengajuanCard({
  item,
  refData,
  isOwn,
}: {
  item: AdminPengajuanItem;
  refData: RefResponse | undefined;
  isOwn: boolean;
}) {
  const pending = item.status === 'Menunggu';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="truncate">{item.pegawai.nama}</CardTitle>
        <CardDescription>
          NIP <span className="font-mono tabular-nums">{item.pegawai.nip}</span>
          {item.pegawai.statusKepegawaian ? <> · {item.pegawai.statusKepegawaian}</> : null}
        </CardDescription>
        <CardAction>
          <PengajuanStatusBadge status={item.status} />
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          <span title={formatDateTimeWITA(item.createdAt)}>
            Diajukan {formatRelative(item.createdAt)} · {formatDateTimeWITA(item.createdAt)}
          </span>
          {item.stale && pending ? (
            <Badge variant="outline" className="border-status-pending/30 bg-status-pending-muted text-status-pending">
              <TriangleAlert data-icon="inline-start" aria-hidden="true" />
              Data sudah berubah sejak diajukan
            </Badge>
          ) : null}
        </div>

        {item.alasan ? (
          <div className="flex flex-col gap-1">
            <p className="text-xs font-medium text-muted-foreground">Alasan</p>
            <p className="text-sm whitespace-pre-line text-foreground">{item.alasan}</p>
          </div>
        ) : null}

        <PerubahanTable perubahan={item.perubahan} refData={refData} />

        {item.reviewedAt ? (
          <p className="text-sm text-muted-foreground">
            {item.status === 'Dibatalkan'
              ? `Dibatalkan pegawai pada ${formatDateTimeWITA(item.reviewedAt)}`
              : `Ditinjau${item.reviewedBy ? ` oleh ${item.reviewedBy.nama}` : ''} pada ${formatDateTimeWITA(item.reviewedAt)}`}
            {item.catatanAdmin ? (
              <>
                <br />
                <span className="font-medium text-foreground">Catatan:</span> {item.catatanAdmin}
              </>
            ) : null}
          </p>
        ) : null}
      </CardContent>
      {pending && isOwn ? (
        <CardFooter className="border-t">
          <p className="text-sm text-muted-foreground">Pengajuan Anda sendiri — harus diverifikasi admin lain.</p>
        </CardFooter>
      ) : pending ? (
        <CardFooter className="flex flex-col-reverse gap-2 border-t sm:flex-row sm:justify-end">
          <RejectDialog item={item} />
          <ApproveDialog item={item} />
        </CardFooter>
      ) : null}
    </Card>
  );
}

function ApproveDialog({ item }: { item: AdminPengajuanItem }) {
  const approve = useApprovePengajuan();
  const [open, setOpen] = useState(false);
  const [catatan, setCatatan] = useState('');

  const confirm = (event: React.MouseEvent) => {
    event.preventDefault();
    approve.mutate(
      { id: item.id, catatan: catatan.trim() || undefined },
      {
        onSuccess: () => {
          toast.success(`Pengajuan ${item.pegawai.nama} disetujui. Data kepegawaian telah diperbarui.`);
          setOpen(false);
        },
        onError: (error) => {
          toast.error(reviewErrorMessage(error));
          setOpen(false);
        },
      },
    );
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (approve.isPending) return;
        setOpen(next);
        if (next) setCatatan('');
      }}
    >
      <AlertDialogTrigger asChild>
        <Button className="w-full sm:w-auto">
          <Check data-icon="inline-start" />
          Setujui
        </Button>
      </AlertDialogTrigger>
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
          <Textarea
            id={`approve-catatan-${item.id}`}
            rows={2}
            maxLength={CATATAN_MAX}
            value={catatan}
            onChange={(event) => setCatatan(event.target.value)}
          />
        </Field>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={approve.isPending}>Batal</AlertDialogCancel>
          <AlertDialogAction disabled={approve.isPending} onClick={confirm}>
            {approve.isPending ? <Spinner data-icon="inline-start" /> : <Check data-icon="inline-start" />}
            Setujui
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function RejectDialog({ item }: { item: AdminPengajuanItem }) {
  const reject = useRejectPengajuan();
  const [open, setOpen] = useState(false);
  const [catatan, setCatatan] = useState('');
  const [error, setError] = useState<string | null>(null);

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
          setOpen(false);
        },
        onError: (err) => {
          if (isApiError(err, 'VALIDATION_ERROR') && err.fields?.catatan) {
            setError(err.fields.catatan);
            return;
          }
          toast.error(reviewErrorMessage(err));
          setOpen(false);
        },
      },
    );
  };

  const fieldId = `reject-catatan-${item.id}`;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (reject.isPending) return;
        setOpen(next);
        if (next) {
          setCatatan('');
          setError(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" className="w-full sm:w-auto">
          <X data-icon="inline-start" />
          Tolak
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Tolak pengajuan</DialogTitle>
          <DialogDescription>
            Catatan akan ditampilkan kepada {item.pegawai.nama} sebagai alasan penolakan.
          </DialogDescription>
        </DialogHeader>
        <form id={`reject-form-${item.id}`} noValidate onSubmit={submit}>
          <Field data-invalid={error ? true : undefined}>
            <FieldLabel htmlFor={fieldId}>Catatan penolakan</FieldLabel>
            <Textarea
              id={fieldId}
              rows={4}
              maxLength={CATATAN_MAX}
              value={catatan}
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
        <DialogFooter>
          <Button variant="outline" disabled={reject.isPending} onClick={() => setOpen(false)}>
            Batal
          </Button>
          <Button type="submit" form={`reject-form-${item.id}`} variant="destructive" disabled={reject.isPending}>
            {reject.isPending ? <Spinner data-icon="inline-start" /> : <X data-icon="inline-start" />}
            Tolak Pengajuan
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
