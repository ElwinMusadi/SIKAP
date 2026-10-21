import { useState } from 'react';
import { ArrowRight, Download, ExternalLink, Eye, FileClock, FileText, FolderOpen, KeyRound, Lock, MoreHorizontal, Pencil, TriangleAlert, UserX } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router';
import { documentFileUrl, isViewableDocumentMime, type DokumenItem } from '@shared/dokumen';
import { KEPEGAWAIAN_FIELDS, KEPEGAWAIAN_LABELS, REQUIRED_PROFILE_FIELDS, type Profile, type RefResponse } from '@shared/profile';
import type { PegawaiDetailResponse } from '@shared/pegawai';
import { PageBackLink, PageHeader } from '@/components/page-header';
import { ProgressMeter } from '@/components/progress-meter';
import { SectionCard } from '@/components/section-card';
import { EmptyState, ErrorState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useMe } from '@/features/auth/queries';
import { formatBytes, fileKind, wajibCounts } from '@/features/dokumen/dokumen-utils';
import { useAdminDocuments } from '@/features/dokumen/queries';
import { PengajuanStatusBadge, PerubahanList } from '@/features/pengajuan/pengajuan-ui';
import { EMPTY_VALUE, formatIsoDate, formatKepegawaianValue, formatPhone } from '@/features/profil/format-values';
import { useRefData } from '@/features/profil/queries';
import { isApiError } from '@/lib/api';
import { formatDateTimeWITA, formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';
import { ACTION_META, availableActions, useAccountActionDialog } from './account-actions';
import { PegawaiFormSheet } from './pegawai-form-sheet';
import { PasswordDefaultBadge, PegawaiAvatar, StatusAkunBadge, StatusKepegawaianBadge } from './pegawai-ui';
import { usePegawaiDetail } from './queries';

type TabValue = 'profil' | 'dokumen' | 'pengajuan';

const BACK = { to: '/admin/pegawai', label: 'Master Data Pegawai' };

export default function PegawaiDetailPage() {
  const params = useParams();
  const parsed = Number(params.id);
  const id = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  const query = usePegawaiDetail(id);

  if (id === null || (query.isError && isApiError(query.error, 'NOT_FOUND'))) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader back={BACK} title="Pegawai tidak ditemukan" />
        <Card className="py-0">
          <EmptyState
            icon={UserX}
            title="Data pegawai tidak ada"
            description="Pegawai ini tidak ada atau sudah dihapus. Pegawai yang dihapus dapat dipulihkan dari tab Terhapus."
            action={
              <>
                <Button asChild variant="outline">
                  <Link to="/admin/pegawai">Kembali ke daftar</Link>
                </Button>
                <Button asChild variant="ghost">
                  <Link to="/admin/pegawai?terhapus=true">Lihat pegawai terhapus</Link>
                </Button>
              </>
            }
          />
        </Card>
      </div>
    );
  }

  if (query.isPending) return <DetailSkeleton />;
  if (query.isError) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader back={BACK} title="Detail pegawai" />
        <Card className="py-0">
          <ErrorState error={query.error} title="Gagal memuat data pegawai" onRetry={() => void query.refetch()} retrying={query.isFetching} />
        </Card>
      </div>
    );
  }
  return <DetailContent data={query.data} />;
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
  const accountActions = allowed.filter((a) => a !== 'delete');
  const isSelf = pegawai.id === me?.id;

  return (
    <div className="flex flex-col gap-6">
      <PageBackLink to={BACK.to} label={BACK.label} />
      <div className="-mt-2 flex flex-col gap-5 sm:flex-row sm:items-end">
        <PegawaiAvatar nama={pegawai.nama} fotoUrl={pegawai.fotoUrl} className="size-16 text-lg shadow-card ring-4 ring-card" />
        <PageHeader
          className="min-w-0 flex-1"
          eyebrow={pegawai.role === 'Admin' ? 'Administrator TU' : 'Pegawai'}
          title={pegawai.nama}
          description={
            <>
              NIP <span className="text-foreground tabular-nums">{pegawai.nip}</span>
              {pegawai.jabatan ? <> · {pegawai.jabatan}</> : null}
            </>
          }
          meta={
            <>
              <StatusKepegawaianBadge status={pegawai.statusKepegawaian} />
              <StatusAkunBadge status={pegawai.statusAkun} />
              {isSelf ? <Badge variant="outline">Akun Anda</Badge> : null}
              {akun.terkunci ? (
                <Badge variant="outline" className="border-status-rejected/25 bg-status-rejected-muted text-status-rejected">
                  <Lock data-icon="inline-start" aria-hidden="true" />
                  Terkunci{akun.lockedUntil ? ` s.d. ${formatDateTimeWITA(akun.lockedUntil)}` : ''}
                </Badge>
              ) : null}
              {akun.isDefaultPassword ? <PasswordDefaultBadge /> : null}
            </>
          }
          actions={
            <>
              {accountActions.length > 0 || allowed.includes('delete') ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="icon" aria-label="Aksi akun lainnya">
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-56">
                    {accountActions.length > 0 ? (
                      <DropdownMenuLabel className="text-eyebrow text-muted-foreground uppercase">Akun</DropdownMenuLabel>
                    ) : null}
                    {accountActions.map((action) => {
                      const meta = ACTION_META[action];
                      return (
                        <DropdownMenuItem key={action} onSelect={() => actions.request(target, action)}>
                          <meta.icon />
                          {meta.label}
                        </DropdownMenuItem>
                      );
                    })}
                    {allowed.includes('delete') ? (
                      <>
                        {accountActions.length > 0 ? <DropdownMenuSeparator /> : null}
                        <DropdownMenuItem variant="destructive" onSelect={() => actions.request(target, 'delete')}>
                          <ACTION_META.delete.icon />
                          Hapus pegawai
                        </DropdownMenuItem>
                      </>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
              <Button onClick={() => setEditOpen(true)}>
                <Pencil data-icon="inline-start" />
                Ubah data
              </Button>
            </>
          }
        />
      </div>

      <Card size="sm" className="px-5">
        <dl className="grid grid-cols-1 gap-x-8 gap-y-3 text-sm sm:grid-cols-3">
          <div className="flex flex-col gap-0.5">
            <dt className="text-eyebrow text-muted-foreground uppercase">Login terakhir</dt>
            <dd title={akun.lastLoginAt ? formatDateTimeWITA(akun.lastLoginAt) : undefined}>
              {akun.lastLoginAt ? formatRelative(akun.lastLoginAt) : 'Belum pernah'}
            </dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-eyebrow text-muted-foreground uppercase">Sesi aktif</dt>
            <dd className="tabular-nums">{akun.sesiAktif}</dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-eyebrow text-muted-foreground uppercase">Password diganti</dt>
            <dd>{akun.passwordChangedAt ? formatRelative(akun.passwordChangedAt) : 'Belum pernah'}</dd>
          </div>
        </dl>
      </Card>

      {isSelf ? (
        <Alert>
          <KeyRound />
          <AlertDescription>
            Ini akun Anda sendiri. Nonaktifkan, hapus, reset password, dan ubah peran tidak tersedia. Ganti password melalui{' '}
            <Link to="/akun" className="font-medium text-foreground underline underline-offset-4">
              Pengaturan akun
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
            {pengajuanAktif ? (
              <span className="rounded-full bg-status-pending-muted px-1.5 text-xs font-semibold text-status-pending">
                1<span className="sr-only"> pengajuan menunggu</span>
              </span>
            ) : null}
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
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Profil tab                                                                 */
/* -------------------------------------------------------------------------- */

interface Row {
  label: string;
  value: string;
  missing?: boolean;
  numeric?: boolean;
}

function InfoCard({ title, description, rows }: { title: string; description?: string; rows: Row[] }) {
  return (
    <SectionCard title={title} description={description}>
      <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
        {rows.map((row) => (
          <div key={row.label} className="flex min-w-0 flex-col gap-0.5">
            <dt className="text-xs text-muted-foreground">{row.label}</dt>
            <dd className={cn('text-sm break-words', row.numeric && 'tabular-nums', row.value === EMPTY_VALUE && 'text-muted-foreground')}>
              {row.value}
              {row.missing ? (
                <span className="ml-2 rounded-full bg-status-pending-muted px-1.5 py-0.5 text-[11px] font-medium text-status-pending">
                  belum diisi
                </span>
              ) : null}
            </dd>
          </div>
        ))}
      </dl>
    </SectionCard>
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
        <Alert className="border-status-pending/25 bg-status-pending-muted">
          <TriangleAlert className="text-status-pending" />
          <AlertTitle>{missingCount} data diri wajib belum diisi</AlertTitle>
          <AlertDescription>Pegawai belum dapat mengunggah dokumen sampai data diri lengkap.</AlertDescription>
        </Alert>
      ) : null}
      <div className="grid gap-4 xl:grid-cols-2">
        <InfoCard
          title="Identitas"
          rows={[
            { label: 'NIK', value: text(profile.nik), missing: req('nik'), numeric: !!profile.nik },
            { label: 'Tempat lahir', value: text(profile.tempatLahir), missing: req('tempatLahir') },
            { label: 'Tanggal lahir', value: formatIsoDate(profile.tanggalLahir), missing: req('tanggalLahir') },
            { label: 'Jenis kelamin', value: text(profile.jenisKelamin), missing: req('jenisKelamin') },
            { label: 'Agama', value: text(profile.agama), missing: req('agama') },
            { label: 'Pendidikan terakhir', value: pendidikan, missing: req('pendidikanKode') },
            { label: 'Status pernikahan', value: text(profile.statusPernikahan), missing: req('statusPernikahan') },
            { label: 'Golongan darah', value: text(profile.golonganDarah) },
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
              { label: 'Nomor HP / WhatsApp', value: formatPhone(profile.noHp), missing: req('noHp'), numeric: true },
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
      <div className="flex flex-col gap-3" aria-busy="true" aria-label="Memuat dokumen">
        <Skeleton className="h-28 w-full rounded-xl" />
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-16 w-full rounded-xl" />
        ))}
      </div>
    );
  }
  if (query.isError) {
    return (
      <Card className="py-0">
        <ErrorState error={query.error} title="Gagal memuat dokumen" onRetry={() => void query.refetch()} retrying={query.isFetching} />
      </Card>
    );
  }

  const { items, summary } = query.data;
  const wajib = items.filter((i) => i.wajib);
  const opsional = items.filter((i) => !i.wajib && i.status !== 'Belum diunggah');

  return (
    <div className="flex flex-col gap-4">
      <SectionCard
        title="Kelengkapan dokumen wajib"
        action={
          summary.counts.Menunggu > 0 ? (
            <Button asChild variant="outline" size="sm">
              <Link to="/admin/verifikasi">
                {summary.counts.Menunggu} menunggu verifikasi
                <ArrowRight data-icon="inline-end" />
              </Link>
            </Button>
          ) : undefined
        }
      >
        <ProgressMeter counts={wajibCounts(items)} label="Terverifikasi" />
      </SectionCard>

      {items.length === 0 ? (
        <Card className="py-0">
          <EmptyState icon={FolderOpen} title="Belum ada dokumen" description="Daftar dokumen wajib muncul setelah status kepegawaian diisi." />
        </Card>
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
    <SectionCard title={title} description={`${items.length} jenis dokumen`} flush>
      <ul className="divide-y">
        {items.map((doc) => (
          <li key={doc.jenisDokumenId} className="flex flex-wrap items-center gap-3 px-5 py-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <FileText className="size-4" aria-hidden="true" />
            </span>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-sm font-medium">{doc.nama}</span>
              <span className="truncate text-xs text-muted-foreground">
                {doc.arsip
                  ? `${doc.arsip.fileName} · diunggah ${formatRelative(doc.arsip.uploadedAt)}`
                  : doc.deleted
                    ? `Dihapus ${formatRelative(doc.deleted.deletedAt)}`
                    : doc.kategori}
              </span>
            </div>
            <StatusBadge status={doc.status} />
            {doc.arsip ? (
              <Button size="sm" variant="ghost" onClick={() => onPreview(doc)}>
                <Eye data-icon="inline-start" />
                Lihat
                <span className="sr-only"> {doc.nama}</span>
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </SectionCard>
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
      <SheetContent side="right" className="w-full gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-3xl">
        <SheetHeader className="gap-2 border-b px-6 py-5 pr-12">
          <div className="flex flex-wrap items-center gap-2">
            <SheetTitle>{item?.nama ?? 'Pratinjau dokumen'}</SheetTitle>
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
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-muted/40 p-4">
          {arsip && kind === 'pdf' ? (
            <iframe src={src} title={`Pratinjau ${arsip.fileName}`} className="h-[70vh] w-full rounded-lg border bg-card" referrerPolicy="no-referrer" />
          ) : arsip && kind === 'image' ? (
            <div className="flex justify-center rounded-lg border bg-card p-2">
              <img src={src} alt={arsip.fileName} className="max-h-[70vh] w-auto max-w-full object-contain" referrerPolicy="no-referrer" />
            </div>
          ) : (
            <EmptyState
              icon={FileText}
              title="Pratinjau tidak tersedia"
              description="Jenis file ini tidak dapat ditampilkan di browser. Unduh file untuk membukanya."
            />
          )}
        </div>
        {arsip ? (
          <SheetFooter className="flex-row flex-wrap gap-2 border-t px-6 py-4">
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
            {item?.status === 'Menunggu' && arsip ? (
              <Button asChild size="sm" className="ml-auto">
                <Link to={`/admin/verifikasi?arsip=${arsip.id}`}>Verifikasi</Link>
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
      <Card className="py-0">
        <EmptyState
          icon={FileClock}
          title="Tidak ada pengajuan aktif"
          description="Pegawai ini tidak memiliki pengajuan perubahan data yang menunggu verifikasi."
        />
      </Card>
    );
  }
  return (
    <SectionCard
      title="Pengajuan perubahan data kepegawaian"
      description={`Dikirim ${formatRelative(p.createdAt)} (${formatDateTimeWITA(p.createdAt)})`}
      action={<PengajuanStatusBadge status={p.status} />}
      footer={
        <Button asChild>
          <Link to="/admin/pengajuan">
            Tinjau di Pengajuan Perubahan
            <ArrowRight data-icon="inline-end" />
          </Link>
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
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
      </div>
    </SectionCard>
  );
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Memuat data pegawai">
      <Skeleton className="h-5 w-40" />
      <div className="flex items-end gap-5">
        <Skeleton className="size-16 rounded-full" />
        <div className="flex flex-1 flex-col gap-2">
          <Skeleton className="h-8 w-72" />
          <Skeleton className="h-4 w-56" />
          <Skeleton className="h-5 w-40" />
        </div>
      </div>
      <Skeleton className="h-16 w-full rounded-xl" />
      <Skeleton className="h-9 w-72" />
      <Skeleton className="h-64 w-full rounded-xl" />
    </div>
  );
}
