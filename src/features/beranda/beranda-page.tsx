import type { LucideIcon } from 'lucide-react';
import {
  ChevronRight,
  CircleCheck,
  CircleDashed,
  ClipboardCheck,
  Clock,
  FileClock,
  FilePen,
  Info,
  PartyPopper,
  RefreshCw,
  Settings,
  TriangleAlert,
  UserRound,
  Users,
} from 'lucide-react';
import { Link } from 'react-router';
import type { SessionUser } from '@shared/api';
import type { DashboardResponse, StatusDokumenView } from '@shared/profile';
import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@/components/ui/item';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { useMe } from '@/features/auth/queries';
import { useAdminPengajuan, useDashboard } from '@/features/profil/queries';
import { errorMessage } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';

/** Leading academic/religious titles that should not be used as a greeting name. */
const TITLE_PREFIXES = new Set(['dr', 'drs', 'dra', 'ir', 'h', 'hj', 'prof', 'st', 'ns', 'apt']);

function firstName(nama: string): string {
  const words = nama.trim().split(/\s+/);
  const name = words.find((word) => {
    const bare = word.replace(/[.,]/g, '').toLowerCase();
    return bare.length > 0 && !word.endsWith('.') && !TITLE_PREFIXES.has(bare);
  });
  return (name ?? words[0] ?? '').replace(/,$/, '');
}

export default function BerandaPage() {
  const { data: user } = useMe();
  if (!user) return null;
  const isAdmin = user.role === 'Admin';

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={`Selamat datang, ${firstName(user.nama)}`}
        description={isAdmin ? 'Panel Administrator TU' : 'Pantau kelengkapan data dan dokumen kepegawaian Anda.'}
      />
      {isAdmin ? <AdminSection /> : null}
      {isAdmin ? (
        <h2 className="text-sm font-semibold text-muted-foreground">Data kepegawaian Anda</h2>
      ) : null}
      <PegawaiDashboard user={user} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Admin                                                                      */
/* -------------------------------------------------------------------------- */

interface QuickLink {
  to: string;
  title: string;
  description: string;
  icon: LucideIcon;
  badge?: number;
}

function AdminSection() {
  const pengajuan = useAdminPengajuan('Menunggu');
  const pending = pengajuan.data?.counts.Menunggu ?? 0;

  const links: QuickLink[] = [
    { to: '/admin/pegawai', title: 'Master Data Pegawai', description: 'Kelola data dan akun pegawai.', icon: Users },
    { to: '/admin/verifikasi', title: 'Verifikasi Dokumen', description: 'Periksa dokumen yang diunggah.', icon: ClipboardCheck },
    {
      to: '/admin/pengajuan',
      title: 'Pengajuan Perubahan',
      description: 'Tinjau perubahan data kepegawaian.',
      icon: FilePen,
      badge: pending,
    },
    { to: '/admin/pengaturan', title: 'Pengaturan Sistem', description: 'Atur konfigurasi aplikasi.', icon: Settings },
  ];

  return (
    <section aria-labelledby="admin-akses" className="flex flex-col gap-3">
      <h2 id="admin-akses" className="sr-only">
        Akses cepat administrator
      </h2>
      <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {links.map((link) => (
          <li key={link.to}>
            <Link to={link.to} className="group block h-full rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
              <Card className="h-full transition-colors group-hover:bg-muted/50">
                <CardHeader>
                  <div className="mb-2 flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <link.icon aria-hidden="true" className="size-5" />
                  </div>
                  <CardTitle>{link.title}</CardTitle>
                  <CardDescription>{link.description}</CardDescription>
                  {link.badge ? (
                    <CardAction>
                      <Badge className="tabular-nums" aria-label={`${link.badge} menunggu`}>
                        {link.badge}
                      </Badge>
                    </CardAction>
                  ) : null}
                </CardHeader>
              </Card>
            </Link>
          </li>
        ))}
      </ul>
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Info aria-hidden="true" className="size-4 shrink-0" />
        Dashboard administrator lengkap tersedia pada Fase 6.
      </p>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Pegawai                                                                    */
/* -------------------------------------------------------------------------- */

interface StatCard {
  status: StatusDokumenView;
  label: string;
  icon: LucideIcon;
  tone: string;
  value: (dokumen: DashboardResponse['dokumen']) => number;
}

const STAT_CARDS: StatCard[] = [
  {
    status: 'Terverifikasi',
    label: 'Terverifikasi',
    icon: CircleCheck,
    tone: 'bg-status-verified-muted text-status-verified',
    value: (d) => d.counts.Terverifikasi ?? 0,
  },
  {
    status: 'Menunggu',
    label: 'Menunggu verifikasi',
    icon: Clock,
    tone: 'bg-status-pending-muted text-status-pending',
    value: (d) => d.counts.Menunggu ?? 0,
  },
  {
    status: 'Ditolak',
    label: 'Ditolak',
    icon: TriangleAlert,
    tone: 'bg-status-rejected-muted text-status-rejected',
    value: (d) => d.counts.Ditolak ?? 0,
  },
  {
    // Only mandatory documents: missing optional documents are not an action item.
    status: 'Belum diunggah',
    label: 'Belum diunggah (wajib)',
    icon: CircleDashed,
    tone: 'bg-status-missing-muted text-status-missing',
    value: (d) => Math.max(0, d.wajibTotal - d.wajibTersedia),
  },
];

function PegawaiDashboard({ user }: { user: SessionUser }) {
  const query = useDashboard();

  if (query.isPending) return <DashboardSkeleton />;
  if (query.isError) {
    return (
      <Alert variant="destructive" role="alert">
        <TriangleAlert />
        <AlertTitle>Gagal memuat ringkasan</AlertTitle>
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

  const data = query.data;
  return (
    <div className="flex flex-col gap-6">
      {data.statusKepegawaianKosong ? (
        <Alert className="border-status-pending/30 bg-status-pending-muted">
          <TriangleAlert className="text-status-pending" />
          <AlertTitle>Status kepegawaian Anda belum diisi</AlertTitle>
          <AlertDescription>
            <p>Dokumen wajib belum dapat ditentukan. Ajukan status kepegawaian melalui pengajuan perubahan data.</p>
            <Button asChild size="sm" variant="outline" className="mt-2 bg-background">
              <Link to="/profil">Buka Profil</Link>
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {data.pengajuanAktif ? (
        <Alert>
          <FileClock />
          <AlertTitle>Pengajuan perubahan data sedang diverifikasi</AlertTitle>
          <AlertDescription>
            Dikirim {formatRelative(data.pengajuanAktif.createdAt)}.{' '}
            <Link to="/profil" className="font-medium text-foreground underline underline-offset-4">
              Lihat detail
            </Link>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-3">
        <DokumenHeroCard data={data} className="lg:col-span-2" />
        <ProfilCompletenessCard data={data} user={user} />
      </div>

      <ul className="grid grid-cols-2 gap-4 lg:grid-cols-4" aria-label="Jumlah dokumen per status">
        {STAT_CARDS.map((stat) => (
          <li key={stat.status}>
            <Card size="sm" className="h-full">
              <CardContent className="flex items-center gap-3">
                <div className={cn('flex size-9 shrink-0 items-center justify-center rounded-lg', stat.tone)}>
                  <stat.icon aria-hidden="true" className="size-4.5" />
                </div>
                <div className="flex min-w-0 flex-col">
                  <span className="text-2xl leading-tight font-semibold tabular-nums">{stat.value(data.dokumen)}</span>
                  <span className="truncate text-xs text-muted-foreground">{stat.label}</span>
                </div>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>

      <PrioritasCard data={data} />
    </div>
  );
}

function DokumenHeroCard({ data, className }: { data: DashboardResponse; className?: string }) {
  const { persen, wajibTerverifikasi, wajibTotal, wajibTersedia } = data.dokumen;
  const done = wajibTotal > 0 && persen === 100;

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>Kelengkapan Dokumen Wajib</CardTitle>
        <CardDescription>Dihitung dari dokumen wajib yang sudah terverifikasi.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5 sm:flex-row sm:items-center">
        <RadialProgress value={persen} done={done} />
        <div className="flex flex-1 flex-col gap-3">
          <p className="text-sm text-foreground">
            <span className="text-lg font-semibold tabular-nums">
              {wajibTerverifikasi}/{wajibTotal}
            </span>{' '}
            dokumen wajib terverifikasi
          </p>
          <Progress value={wajibTotal ? (wajibTersedia / wajibTotal) * 100 : 0} className="h-2" aria-label="Dokumen wajib tersedia" />
          <p className="text-sm text-muted-foreground">
            <span className="font-medium tabular-nums text-foreground">{wajibTersedia}</span> dokumen wajib sudah tersedia
            (termasuk yang menunggu verifikasi).
          </p>
          <Button asChild variant="outline" size="sm" className="w-fit">
            <Link to="/dokumen">
              Kelola Arsip Dokumen
              <ChevronRight data-icon="inline-end" />
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function RadialProgress({ value, done }: { value: number; done: boolean }) {
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div
      role="img"
      aria-label={`Kelengkapan dokumen wajib ${clamped} persen`}
      className="relative mx-auto size-32 shrink-0 sm:mx-0"
    >
      <svg viewBox="0 0 100 100" className="size-full -rotate-90" aria-hidden="true">
        <circle cx="50" cy="50" r={radius} fill="none" strokeWidth="10" className="stroke-muted" />
        <circle
          cx="50"
          cy="50"
          r={radius}
          fill="none"
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - clamped / 100)}
          className={cn('transition-[stroke-dashoffset] duration-500 motion-reduce:transition-none', done ? 'stroke-status-verified' : 'stroke-primary')}
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-3xl font-semibold tabular-nums" aria-hidden="true">
        {clamped}%
      </span>
    </div>
  );
}

function ProfilCompletenessCard({ data, user }: { data: DashboardResponse; user: SessionUser }) {
  const { terisi, total, persen, missingFields } = data.profil;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Data Diri</CardTitle>
        <CardDescription>{user.nama}</CardDescription>
        <CardAction>
          <span className="text-sm font-medium tabular-nums">
            {terisi}/{total}
          </span>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-4">
        <Progress
          value={persen}
          className={cn('h-2', persen === 100 && '*:bg-status-verified')}
          aria-label={`Data diri lengkap ${terisi} dari ${total}`}
        />
        {missingFields.length > 0 ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-muted-foreground">Belum diisi (wajib sebelum mengunggah dokumen):</p>
            <ul className="flex flex-wrap gap-1.5">
              {missingFields.map((field) => (
                <li key={field}>
                  <Badge variant="outline">{field}</Badge>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="flex items-center gap-2 text-sm text-status-verified">
            <CircleCheck aria-hidden="true" className="size-4" />
            Data diri sudah lengkap.
          </p>
        )}
        <Button asChild variant={missingFields.length > 0 ? 'default' : 'outline'} size="sm" className="mt-auto w-fit">
          <Link to="/profil">
            <UserRound data-icon="inline-start" />
            {missingFields.length > 0 ? 'Lengkapi Profil' : 'Lihat Profil'}
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}

function PrioritasCard({ data }: { data: DashboardResponse }) {
  const items = data.dokumen.prioritas;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Yang perlu Anda lakukan</CardTitle>
        <CardDescription>Dokumen yang ditolak, belum diunggah, atau masih menunggu verifikasi.</CardDescription>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <Empty className="border border-dashed py-8">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <PartyPopper />
              </EmptyMedia>
              <EmptyTitle>{data.statusKepegawaianKosong ? 'Belum ada daftar dokumen' : 'Tidak ada tindakan diperlukan'}</EmptyTitle>
              <EmptyDescription>
                {data.statusKepegawaianKosong
                  ? 'Daftar dokumen wajib muncul setelah status kepegawaian Anda terisi.'
                  : 'Semua dokumen wajib Anda sudah lengkap dan terverifikasi.'}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ItemGroup className="gap-2">
            {items.map((doc) => (
              <Item key={doc.jenisDokumenId} variant="outline" size="sm" asChild>
                <Link to={`/dokumen?jenis=${encodeURIComponent(doc.jenisDokumenId)}`}>
                  <ItemContent>
                    <ItemTitle className="flex-wrap">
                      {doc.nama}
                      {doc.wajib ? <span className="text-xs font-normal text-muted-foreground">Wajib</span> : null}
                    </ItemTitle>
                    {doc.status === 'Ditolak' && doc.catatanAdmin ? (
                      <ItemDescription className="text-status-rejected">Catatan: {doc.catatanAdmin}</ItemDescription>
                    ) : (
                      <ItemDescription>{doc.kategori}</ItemDescription>
                    )}
                  </ItemContent>
                  <ItemActions>
                    <StatusBadge status={doc.status} />
                    <ChevronRight aria-hidden="true" className="size-4 text-muted-foreground" />
                  </ItemActions>
                </Link>
              </Item>
            ))}
          </ItemGroup>
        )}
      </CardContent>
    </Card>
  );
}

function DashboardSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Memuat ringkasan">
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardContent className="flex items-center gap-5">
            <Skeleton className="size-32 rounded-full" />
            <div className="flex flex-1 flex-col gap-3">
              <Skeleton className="h-5 w-48" />
              <Skeleton className="h-2 w-full" />
              <Skeleton className="h-4 w-64" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex flex-col gap-3">
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-2 w-full" />
            <Skeleton className="h-4 w-40" />
          </CardContent>
        </Card>
      </div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-20 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-48 rounded-xl" />
    </div>
  );
}
