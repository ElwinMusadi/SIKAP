import { useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  Eye,
  FileClock,
  FileText,
  FolderOpen,
  KeyRound,
  Lock,
  Pencil,
  RefreshCw,
  TriangleAlert,
  UserX,
} from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router';
import { documentFileUrl, isViewableDocumentMime, type DokumenItem } from '@shared/dokumen';
import { KEPEGAWAIAN_FIELDS, KEPEGAWAIAN_LABELS, REQUIRED_PROFILE_FIELDS, type Profile, type RefResponse } from '@shared/profile';
import type { PegawaiDetailResponse } from '@shared/pegawai';
import { StatusBadge } from '@/components/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@/components/ui/item';
import { Progress } from '@/components/ui/progress';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useMe } from '@/features/auth/queries';
import { formatBytes, fileKind } from '@/features/dokumen/dokumen-utils';
import { useAdminDocuments } from '@/features/dokumen/queries';
import { PengajuanStatusBadge, PerubahanList } from '@/features/pengajuan/pengajuan-ui';
import { EMPTY_VALUE, formatIsoDate, formatKepegawaianValue, formatPhone } from '@/features/profil/format-values';
import { useRefData } from '@/features/profil/queries';
import { errorMessage, isApiError } from '@/lib/api';
import { formatDateTimeWITA, formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';
import { ACTION_META, availableActions, useAccountActionDialog } from './account-actions';
import { PegawaiFormSheet } from './pegawai-form-sheet';
import { PasswordDefaultBadge, PegawaiAvatar, StatusAkunBadge, StatusKepegawaianBadge } from './pegawai-ui';
import { usePegawaiDetail } from './queries';

type TabValue = 'profil' | 'dokumen' | 'pengajuan';

function BackLink() {
  return (
    <Button asChild variant="ghost" size="sm" className="-ml-2 w-fit text-muted-foreground">
      <Link to="/admin/pegawai">
        <ChevronLeft data-icon="inline-start" />
        Master Data Pegawai
      </Link>
    </Button>
  );
}

export default function PegawaiDetailPage() {
  const params = useParams();
  const parsed = Number(params.id);
  const id = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  const query = usePegawaiDetail(id);

  if (id === null || (query.isError && isApiError(query.error, 'NOT_FOUND'))) {
    return (
      <div className="flex flex-col gap-6">
        <BackLink />
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <UserX />
            </EmptyMedia>
            <EmptyTitle>Pegawai tidak ditemukan</EmptyTitle>
            <EmptyDescription>
              Data pegawai ini tidak ada atau sudah dihapus. Pegawai yang dihapus dapat dipulihkan dari tab Terhapus.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <div className="flex flex-wrap justify-center gap-2">
              <Button asChild variant="outline">
                <Link to="/admin/pegawai">Kembali ke daftar</Link>
              </Button>
              <Button asChild variant="ghost">
                <Link to="/admin/pegawai?terhapus=true">Lihat pegawai terhapus</Link>
              </Button>
            </div>
          </EmptyContent>
        </Empty>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <BackLink />
      {query.isPending ? (
        <DetailSkeleton />
      ) : query.isError ? (
        <Alert variant="destructive" role="alert">
          <TriangleAlert />
          <AlertTitle>Gagal memuat data pegawai</AlertTitle>
          <AlertDescription>
            <p>{errorMessage(query.error)}</p>
            <Button size="sm" variant="outline" className="mt-2" onClick={() => void query.refetch()}>
              <RefreshCw data-icon="inline-start" />
              Coba lagi
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <DetailContent data={query.data} />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Content                                                                    */
/* -------------------------------------------------------------------------- */

function DetailContent({ data }: { data: PegawaiDetailResponse }) {
  const { pegawai, akun, pengajuanAktif } = data;
  const navigate = useNavigate();
  const { data: me } = useMe();
  const refQuery = useRefData();
  const [tab, setTab] = useState<TabValue>('profil');
  const [editOpen, setEditOpen] = useState(false);
  const actions = useAccountActionDialog((action) => {
    if (action === 'delete') void navigate('/admin/pegawai', { replace: true });
  });
  const target = { id: pegawai.id, nama: pegawai.nama, statusAkun: pegawai.statusAkun, terkunci: akun.terkunci };
  const allowed = availableActions(target, me?.id);
  const isSelf = pegawai.id === me?.id;

  return (
    <>
      <Card>
        <CardContent className="flex flex-col gap-5 lg:flex-row lg:items-start">
          <PegawaiAvatar nama={pegawai.nama} fotoUrl={pegawai.fotoUrl} className="size-16 text-lg" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="font-heading text-xl font-semibold tracking-tight">{pegawai.nama}</h1>
              {isSelf ? <Badge variant="outline">Anda</Badge> : null}
            </div>
            <p className="text-sm text-muted-foreground">
              NIP <span className="font-mono text-foreground tabular-nums">{pegawai.nip}</span>
              <span aria-hidden="true"> · </span>
              {pegawai.role === 'Admin' ? 'Administrator TU' : 'Pegawai'}
              {pegawai.jabatan ? (
                <>
                  <span aria-hidden="true"> · </span>
                  {pegawai.jabatan}
                </>
              ) : null}
            </p>
            <div className="flex flex-wrap items-center gap-1.5">
              <StatusKepegawaianBadge status={pegawai.statusKepegawaian} />
              <StatusAkunBadge status={pegawai.statusAkun} />
              {akun.terkunci ? (
                <Badge variant="outline" className="border-status-rejected/30 bg-status-rejected-muted text-status-rejected">
                  <Lock data-icon="inline-start" aria-hidden="true" />
                  Terkunci{akun.lockedUntil ? ` s.d. ${formatDateTimeWITA(akun.lockedUntil)}` : ''}
                </Badge>
              ) : null}
              {akun.isDefaultPassword ? <PasswordDefaultBadge /> : null}
            </div>
            <dl className="mt-1 grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
              <div className="flex flex-col">
                <dt className="text-xs text-muted-foreground">Login terakhir</dt>
                <dd title={akun.lastLoginAt ? formatDateTimeWITA(akun.lastLoginAt) : undefined}>
                  {akun.lastLoginAt ? formatRelative(akun.lastLoginAt) : 'Belum pernah'}
                </dd>
              </div>
              <div className="flex flex-col">
                <dt className="text-xs text-muted-foreground">Sesi aktif</dt>
                <dd className="tabular-nums">{akun.sesiAktif}</dd>
              </div>
              <div className="flex flex-col">
                <dt className="text-xs text-muted-foreground">Password diganti</dt>
                <dd>{akun.passwordChangedAt ? formatRelative(akun.passwordChangedAt) : 'Belum pernah'}</dd>
              </div>
            </dl>
          </div>
          <div className="flex flex-wrap gap-2 lg:max-w-80 lg:justify-end">
            <Button onClick={() => setEditOpen(true)}>
              <Pencil data-icon="inline-start" />
              Edit
            </Button>
            {allowed
              .filter((a) => a !== 'delete')
              .map((action) => {
                const meta = ACTION_META[action];
                return (
                  <Button key={action} variant="outline" onClick={() => actions.request(target, action)}>
                    <meta.icon data-icon="inline-start" />
                    {meta.label}
                  </Button>
                );
              })}
            {allowed.includes('delete') ? (
              <Button variant="destructive" onClick={() => actions.request(target, 'delete')}>
                <ACTION_META.delete.icon data-icon="inline-start" />
                Hapus
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {isSelf ? (
        <Alert>
          <KeyRound />
          <AlertDescription>
            Ini akun Anda sendiri. Nonaktifkan, hapus, reset password, dan ubah peran tidak tersedia. Ganti password melalui{' '}
            <Link to="/akun" className="font-medium text-foreground underline underline-offset-4">
              Pengaturan Akun
            </Link>
            .
          </AlertDescription>
        </Alert>
      ) : null}

      <Tabs value={tab} onValueChange={(v) => setTab(v as TabValue)} className="gap-4">
        <TabsList className="w-full sm:w-fit">
          <TabsTrigger value="profil">Profil</TabsTrigger>
          <TabsTrigger value="dokumen">Dokumen</TabsTrigger>
          <TabsTrigger value="pengajuan">
            Pengajuan
            {pengajuanAktif ? <span className="size-1.5 rounded-full bg-status-pending" aria-label="ada pengajuan menunggu" /> : null}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="profil">
          <ProfilTab profile={pegawai} refData={refQuery.data} />
        </TabsContent>
        <TabsContent value="dokumen">
          <DokumenTab pegawaiId={pegawai.id} />
        </TabsContent>
        <TabsContent value="pengajuan">
          <PengajuanTab data={data} refData={refQuery.data} />
        </TabsContent>
      </Tabs>

      <PegawaiFormSheet open={editOpen} onOpenChange={setEditOpen} pegawaiId={pegawai.id} />
      {actions.dialog}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Profil tab                                                                 */
/* -------------------------------------------------------------------------- */

interface Row {
  label: string;
  value: string;
  missing?: boolean;
  mono?: boolean;
}

function InfoCard({ title, description, rows }: { title: string; description?: string; rows: Row[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent>
        <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
          {rows.map((row) => (
            <div key={row.label} className="flex min-w-0 flex-col gap-0.5">
              <dt className="text-xs text-muted-foreground">{row.label}</dt>
              <dd className={cn('text-sm break-words', row.mono && 'font-mono tabular-nums', row.value === EMPTY_VALUE && 'text-muted-foreground')}>
                {row.value}
                {row.missing ? <span className="ml-2 text-xs text-status-pending">belum diisi</span> : null}
              </dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

function ProfilTab({ profile, refData }: { profile: Profile; refData: RefResponse | undefined }) {
  const text = (v: string | null) => (v ? v : EMPTY_VALUE);
  const req = (key: keyof typeof REQUIRED_PROFILE_FIELDS) => {
    const v = profile[key];
    return v === null || v === '';
  };
  const pendidikan = profile.pendidikanKode
    ? (refData?.pendidikan.find((p) => p.kode === profile.pendidikanKode)?.nama ?? profile.pendidikanKode)
    : EMPTY_VALUE;
  const missingCount = (Object.keys(REQUIRED_PROFILE_FIELDS) as (keyof typeof REQUIRED_PROFILE_FIELDS)[]).filter(req).length;

  return (
    <div className="flex flex-col gap-4">
      {missingCount > 0 ? (
        <Alert className="border-status-pending/30 bg-status-pending-muted">
          <TriangleAlert className="text-status-pending" />
          <AlertDescription>
            {missingCount} data diri wajib belum diisi. Pegawai belum dapat mengunggah dokumen sampai data diri lengkap.
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="grid gap-4 xl:grid-cols-2">
        <InfoCard
          title="Identitas"
          rows={[
            { label: 'NIK', value: text(profile.nik), missing: req('nik'), mono: !!profile.nik },
            { label: 'Tempat Lahir', value: text(profile.tempatLahir), missing: req('tempatLahir') },
            { label: 'Tanggal Lahir', value: formatIsoDate(profile.tanggalLahir), missing: req('tanggalLahir') },
            { label: 'Jenis Kelamin', value: text(profile.jenisKelamin), missing: req('jenisKelamin') },
            { label: 'Agama', value: text(profile.agama), missing: req('agama') },
            { label: 'Pendidikan Terakhir', value: pendidikan, missing: req('pendidikanKode') },
            { label: 'Status Pernikahan', value: text(profile.statusPernikahan), missing: req('statusPernikahan') },
            { label: 'Golongan Darah', value: text(profile.golonganDarah) },
          ]}
        />
        <div className="flex flex-col gap-4">
          <InfoCard
            title="Kepegawaian"
            rows={KEPEGAWAIAN_FIELDS.map((field) => ({
              label: KEPEGAWAIAN_LABELS[field],
              value: formatKepegawaianValue(field, profile[field], refData),
            }))}
          />
          <InfoCard
            title="Kontak"
            rows={[
              { label: 'Nomor HP / WhatsApp', value: formatPhone(profile.noHp), missing: req('noHp') },
              { label: 'Email', value: text(profile.email), missing: req('email') },
              { label: 'Alamat', value: text(profile.alamat), missing: req('alamat') },
            ]}
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">Terakhir diperbarui {formatDateTimeWITA(profile.updatedAt)}.</p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Dokumen tab (read-only)                                                    */
/* -------------------------------------------------------------------------- */

function DokumenTab({ pegawaiId }: { pegawaiId: number }) {
  const query = useAdminDocuments(pegawaiId);
  const [preview, setPreview] = useState<DokumenItem | null>(null);

  if (query.isPending) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true" aria-label="Memuat dokumen">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-14 w-full rounded-lg" />
        ))}
      </div>
    );
  }
  if (query.isError) {
    return (
      <Alert variant="destructive" role="alert">
        <TriangleAlert />
        <AlertTitle>Gagal memuat dokumen</AlertTitle>
        <AlertDescription>
          <p>{errorMessage(query.error)}</p>
          <Button size="sm" variant="outline" className="mt-2" onClick={() => void query.refetch()}>
            <RefreshCw data-icon="inline-start" />
            Coba lagi
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const { items, summary } = query.data;
  const wajib = items.filter((i) => i.wajib);
  const opsional = items.filter((i) => !i.wajib && i.status !== 'Belum diunggah');

  return (
    <div className="flex flex-col gap-4">
      <Card size="sm">
        <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="flex flex-1 flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className="text-muted-foreground">Dokumen wajib terverifikasi</span>
              <span className="font-medium tabular-nums">
                {summary.wajibTerverifikasi}/{summary.wajibTotal} ({summary.persen}%)
              </span>
            </div>
            <Progress
              value={summary.persen}
              className={cn('h-2', summary.persen === 100 && summary.wajibTotal > 0 && '*:bg-status-verified')}
              aria-label={`Dokumen wajib terverifikasi ${summary.persen} persen`}
            />
          </div>
          {summary.counts.Menunggu > 0 ? (
            <Button asChild variant="outline" size="sm">
              <Link to="/admin/verifikasi">
                {summary.counts.Menunggu} menunggu verifikasi
                <ChevronRight data-icon="inline-end" />
              </Link>
            </Button>
          ) : null}
        </CardContent>
      </Card>

      {items.length === 0 ? (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FolderOpen />
            </EmptyMedia>
            <EmptyTitle>Belum ada dokumen</EmptyTitle>
            <EmptyDescription>Daftar dokumen wajib muncul setelah status kepegawaian diisi.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <DokumenGroup title="Dokumen wajib" items={wajib} onPreview={setPreview} />
          {opsional.length > 0 ? <DokumenGroup title="Dokumen opsional" items={opsional} onPreview={setPreview} /> : null}
        </>
      )}

      <AdminPreviewSheet item={preview} onOpenChange={(open) => !open && setPreview(null)} />
    </div>
  );
}

function DokumenGroup({ title, items, onPreview }: { title: string; items: DokumenItem[]; onPreview: (item: DokumenItem) => void }) {
  return (
    <section className="flex flex-col gap-2" aria-label={title}>
      <h2 className="text-sm font-semibold text-muted-foreground">{title}</h2>
      <ItemGroup className="gap-2">
        {items.map((doc) => (
          <Item key={doc.jenisDokumenId} variant="outline" size="sm">
            <ItemContent>
              <ItemTitle className="flex-wrap">{doc.nama}</ItemTitle>
              <ItemDescription>
                {doc.arsip
                  ? `${doc.arsip.fileName} · diunggah ${formatRelative(doc.arsip.uploadedAt)}`
                  : doc.deleted
                    ? `Dihapus ${formatRelative(doc.deleted.deletedAt)}`
                    : doc.kategori}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <StatusBadge status={doc.status} />
              {doc.arsip ? (
                <Button size="sm" variant="ghost" onClick={() => onPreview(doc)}>
                  <Eye data-icon="inline-start" />
                  Lihat
                  <span className="sr-only"> {doc.nama}</span>
                </Button>
              ) : null}
            </ItemActions>
          </Item>
        ))}
      </ItemGroup>
    </section>
  );
}

/** Read-only preview: verification happens in /admin/verifikasi, not here. */
function AdminPreviewSheet({ item, onOpenChange }: { item: DokumenItem | null; onOpenChange: (open: boolean) => void }) {
  const arsip = item?.arsip ?? null;
  const viewable = arsip ? isViewableDocumentMime(arsip.mimeType) : false;
  const kind = arsip && viewable ? fileKind(arsip.mimeType) : 'other';
  const src = arsip ? documentFileUrl(arsip.id) : '';

  return (
    <Sheet open={item !== null} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 data-[side=right]:sm:max-w-3xl">
        <SheetHeader className="gap-2 border-b pr-12">
          <div className="flex flex-wrap items-center gap-2">
            <SheetTitle className="text-base">{item?.nama ?? 'Pratinjau dokumen'}</SheetTitle>
            {item ? <StatusBadge status={item.status} /> : null}
          </div>
          <SheetDescription>
            {arsip ? `${arsip.fileName} · ${formatBytes(arsip.sizeBytes)} · versi ${arsip.versi} · ${formatDateTimeWITA(arsip.uploadedAt)}` : ''}
          </SheetDescription>
          {arsip?.catatanAdmin ? (
            <Alert variant={item?.status === 'Ditolak' ? 'destructive' : 'default'}>
              <TriangleAlert />
              <AlertTitle>Catatan admin</AlertTitle>
              <AlertDescription>{arsip.catatanAdmin}</AlertDescription>
            </Alert>
          ) : null}
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
          {arsip && kind === 'pdf' ? (
            <iframe src={src} title={`Pratinjau ${arsip.fileName}`} className="h-[70vh] w-full rounded-md border bg-muted" referrerPolicy="no-referrer" />
          ) : arsip && kind === 'image' ? (
            <div className="flex justify-center rounded-md border bg-muted/40 p-2">
              <img src={src} alt={arsip.fileName} className="max-h-[70vh] w-auto max-w-full object-contain" referrerPolicy="no-referrer" />
            </div>
          ) : (
            <Empty className="border border-dashed">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FileText />
                </EmptyMedia>
                <EmptyTitle>Pratinjau tidak tersedia</EmptyTitle>
                <EmptyDescription>Jenis file ini tidak dapat ditampilkan di browser. Unduh file untuk membukanya.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </div>
        {arsip ? (
          <SheetFooter className="flex-row flex-wrap gap-2 border-t">
            <Button asChild variant="outline" size="sm">
              <a href={documentFileUrl(arsip.id, { download: true })} rel="noopener" download>
                <Download data-icon="inline-start" />
                Unduh
              </a>
            </Button>
            {viewable ? (
              <Button asChild variant="outline" size="sm">
                <a href={src} target="_blank" rel="noopener noreferrer">
                  <ExternalLink data-icon="inline-start" />
                  Buka di tab baru
                  <span className="sr-only"> (tab baru)</span>
                </a>
              </Button>
            ) : null}
            {item?.status === 'Menunggu' ? (
              <Button asChild size="sm" className="ml-auto">
                <Link to="/admin/verifikasi">Verifikasi</Link>
              </Button>
            ) : null}
          </SheetFooter>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

/* -------------------------------------------------------------------------- */
/* Pengajuan tab                                                              */
/* -------------------------------------------------------------------------- */

function PengajuanTab({ data, refData }: { data: PegawaiDetailResponse; refData: RefResponse | undefined }) {
  const p = data.pengajuanAktif;
  if (!p) {
    return (
      <Empty className="border border-dashed">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FileClock />
          </EmptyMedia>
          <EmptyTitle>Tidak ada pengajuan aktif</EmptyTitle>
          <EmptyDescription>Pegawai ini tidak memiliki pengajuan perubahan data yang menunggu verifikasi.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Pengajuan perubahan data kepegawaian</CardTitle>
        <CardDescription>
          Dikirim {formatRelative(p.createdAt)} ({formatDateTimeWITA(p.createdAt)})
        </CardDescription>
        <CardAction>
          <PengajuanStatusBadge status={p.status} />
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <PerubahanList perubahan={p.perubahan} refData={refData} />
        {p.alasan ? (
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-muted-foreground">Alasan</span>
            <p className="text-sm">{p.alasan}</p>
          </div>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Perubahan yang Anda simpan langsung di sini tidak menutup pengajuan ini; pengajuan dapat ditandai usang di halaman pengajuan.
        </p>
        <Button asChild className="w-fit">
          <Link to="/admin/pengajuan">
            Tinjau di Pengajuan Perubahan
            <ChevronRight data-icon="inline-end" />
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Memuat data pegawai">
      <Card>
        <CardContent className="flex items-center gap-5">
          <Skeleton className="size-16 rounded-full" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-6 w-64" />
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-5 w-40" />
          </div>
        </CardContent>
      </Card>
      <Skeleton className="h-8 w-72" />
      <Skeleton className="h-64 w-full rounded-xl" />
    </div>
  );
}
