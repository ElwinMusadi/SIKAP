import { lazy, Suspense } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  ChevronRight,
  CircleCheck,
  ClipboardCheck,
  Clock,
  FileClock,
  FileImage,
  FilePen,
  FileText,
  FileUp,
  PartyPopper,
  Upload,
  UserPlus,
  UserRound,
  UserRoundPen,
} from 'lucide-react';
import { Link } from 'react-router';
import type { SessionUser } from '@shared/api';
import type { DashboardResponse } from '@shared/profile';
import { PageHeader } from '@/components/page-header';
import { ProgressMeter } from '@/components/progress-meter';
import { SectionCard } from '@/components/section-card';
import { EmptyState, ErrorState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useMe } from '@/features/auth/queries';
import { AdminDashboardSkeleton } from '@/features/beranda/admin-dashboard-skeleton';
import { fileKind, recentUploads, wajibCounts } from '@/features/dokumen/dokumen-utils';
import { useDocuments } from '@/features/dokumen/queries';
import { useDashboard } from '@/features/profil/queries';
import { formatDateTimeWITA, formatRelative } from '@/lib/format';
import { countsFromSummary } from '@/lib/progress';
import { TONE_CLASSES } from '@/lib/status';
import { cn } from '@/lib/utils';
import { pegawaiTasks, type PegawaiTask, type PegawaiTaskKind } from './pegawai-tasks';

// Charts (recharts) live in their own chunk so pegawai never download them.
const AdminDashboard = lazy(() => import('@/features/beranda/admin-dashboard').then((m) => ({ default: m.AdminDashboard })));

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

  const today = new Intl.DateTimeFormat('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Makassar' }).format(new Date());

  if (!isAdmin) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          eyebrow={today}
          title={`Selamat datang, ${firstName(user.nama)}`}
          description="Pantau kelengkapan data dan dokumen kepegawaian Anda."
          actions={
            <Button asChild>
              <Link to="/dokumen">
                <Upload data-icon="inline-start" />
                Unggah dokumen
              </Link>
            </Button>
          }
        />
        <PegawaiDashboard user={user} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={today}
        title={`Selamat datang, ${firstName(user.nama)}`}
        description="Ringkasan instansi dan pekerjaan Administrator TU hari ini."
        actions={
          <>
            <Button asChild variant="outline">
              <Link to="/admin/pegawai?tambah=1">
                <UserPlus data-icon="inline-start" />
                Tambah pegawai
              </Link>
            </Button>
            <Button asChild>
              <Link to="/admin/verifikasi">
                <ClipboardCheck data-icon="inline-start" />
                Verifikasi dokumen
              </Link>
            </Button>
          </>
        }
      />
      <Tabs defaultValue="instansi" className="gap-6">
        <TabsList>
          <TabsTrigger value="instansi">Instansi</TabsTrigger>
          <TabsTrigger value="saya">Data saya</TabsTrigger>
        </TabsList>
        <TabsContent value="instansi">
          <Suspense fallback={<AdminDashboardSkeleton />}>
            <AdminDashboard />
          </Suspense>
        </TabsContent>
        <TabsContent value="saya">
          <PegawaiDashboard user={user} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Pegawai                                                                    */
/* -------------------------------------------------------------------------- */

function PegawaiDashboard({ user }: { user: SessionUser }) {
  const query = useDashboard();
  const documents = useDocuments();

  if (query.isPending) return <DashboardSkeleton />;
  if (query.isError) {
    return (
      <Card className="py-0">
        <ErrorState error={query.error} title="Gagal memuat ringkasan" onRetry={() => void query.refetch()} retrying={query.isFetching} />
      </Card>
    );
  }

  const data = query.data;
  const items = documents.data?.items;
  return (
    <div className="grid items-start gap-6 lg:grid-cols-3">
      <div className="flex min-w-0 flex-col gap-6 lg:col-span-2">
        <KelengkapanCard data={data} counts={items ? wajibCounts(items) : null} loading={documents.isPending} />
        <TasksCard tasks={pegawaiTasks(data)} statusKosong={data.statusKepegawaianKosong} />
      </div>
      <div className="flex min-w-0 flex-col gap-6">
        <DataDiriCard data={data} user={user} />
        <RecentDocumentsCard items={items} loading={documents.isPending} />
        <PengajuanCard data={data} />
      </div>
    </div>
  );
}

function KelengkapanCard({
  data,
  counts,
  loading,
}: {
  data: DashboardResponse;
  counts: ReturnType<typeof wajibCounts> | null;
  loading: boolean;
}) {
  const { wajibTotal, wajibTerverifikasi, wajibTersedia } = data.dokumen;
  // Without the document list (still loading or failed) the summary splits "uploaded" only roughly.
  const shown = counts ?? countsFromSummary({ wajibTotal, wajibTerverifikasi, menunggu: wajibTersedia - wajibTerverifikasi });
  return (
    <SectionCard
      title="Kelengkapan dokumen wajib"
      description="Dihitung dari dokumen wajib yang sudah terverifikasi."
      action={
        <Button asChild variant="ghost" size="sm">
          <Link to="/dokumen" aria-label="Buka arsip dokumen">
            Arsip
            <ChevronRight data-icon="inline-end" />
          </Link>
        </Button>
      }
    >
      {data.statusKepegawaianKosong ? (
        <p className="text-sm text-muted-foreground">Dokumen wajib ditentukan dari status kepegawaian, yang belum diisi.</p>
      ) : loading ? (
        <div className="flex flex-col gap-3" aria-busy="true" aria-label="Memuat kelengkapan">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-2.5 w-full" />
          <Skeleton className="h-4 w-72" />
        </div>
      ) : (
        <ProgressMeter counts={shown} label="Terverifikasi" />
      )}
    </SectionCard>
  );
}

const TASK_STYLE: Record<PegawaiTaskKind, { icon: LucideIcon; tone: string }> = {
  profil: { icon: UserRoundPen, tone: 'bg-accent-soft text-primary' },
  status: { icon: FilePen, tone: 'bg-accent-soft text-primary' },
  perbaiki: { icon: FilePen, tone: TONE_CLASSES.rejected.soft },
  unggah: { icon: FileUp, tone: 'bg-accent-soft text-primary' },
  menunggu: { icon: Clock, tone: TONE_CLASSES.pending.soft },
};

function TasksCard({ tasks, statusKosong }: { tasks: PegawaiTask[]; statusKosong: boolean }) {
  const actionable = tasks.filter((t) => t.action).length;
  return (
    <SectionCard
      title="Yang perlu Anda lakukan"
      description={actionable > 0 ? 'Kerjakan berurutan dari atas.' : undefined}
      action={actionable > 0 ? <Badge variant="secondary" className="tabular-nums">{actionable} langkah</Badge> : undefined}
      flush
    >
      {tasks.length === 0 ? (
        <EmptyState
          icon={PartyPopper}
          size="inline"
          title={statusKosong ? 'Belum ada daftar dokumen' : 'Semua beres'}
          description={
            statusKosong
              ? 'Daftar dokumen wajib muncul setelah status kepegawaian Anda terisi.'
              : 'Data diri lengkap dan semua dokumen wajib sudah terverifikasi.'
          }
        />
      ) : (
        <ol className="divide-y">
          {tasks.map((task, index) => {
            const style = TASK_STYLE[task.kind];
            const primary = task.action !== undefined && tasks.findIndex((t) => t.action) === index;
            return (
              <li key={task.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  <span className={cn('relative flex size-9 shrink-0 items-center justify-center rounded-full', style.tone)}>
                    <style.icon className="size-4" aria-hidden="true" />
                    {task.action ? (
                      <span className="absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-full bg-card text-[0.625rem] font-semibold text-muted-foreground tabular-nums ring-1 ring-border">
                        {index + 1}
                      </span>
                    ) : null}
                  </span>
                  <div className="flex min-w-0 flex-col gap-0.5 pt-0.5">
                    <p className="text-sm font-medium text-foreground">{task.title}</p>
                    {task.description ? <p className="text-sm text-muted-foreground">{task.description}</p> : null}
                  </div>
                </div>
                {task.action ? (
                  <Button asChild size="sm" variant={primary ? 'default' : 'outline'} className="self-start sm:self-center">
                    <Link to={task.action.to}>
                      {task.action.label}
                      <ChevronRight data-icon="inline-end" />
                    </Link>
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </SectionCard>
  );
}

function DataDiriCard({ data, user }: { data: DashboardResponse; user: SessionUser }) {
  const { terisi, total, missingFields } = data.profil;
  const done = missingFields.length === 0;
  return (
    <SectionCard
      title="Data diri"
      description={user.nama}
      action={
        <span className={cn('text-sm font-medium tabular-nums', done ? 'text-status-verified' : 'text-foreground')}>
          {terisi}/{total}
        </span>
      }
    >
      <div className="flex flex-col gap-4">
        <div
          role="img"
          aria-label={`Data diri terisi ${terisi} dari ${total}`}
          className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted"
        >
          <span className={cn('h-full rounded-full', done ? 'bg-status-verified' : 'bg-primary')} style={{ width: `${total ? (terisi / total) * 100 : 0}%` }} />
        </div>
        {done ? (
          <p className="flex items-center gap-2 text-sm text-status-verified">
            <CircleCheck aria-hidden="true" className="size-4" />
            Data diri sudah lengkap.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-muted-foreground">Wajib diisi sebelum mengunggah dokumen:</p>
            <ul className="flex flex-wrap gap-1.5">
              {missingFields.map((field) => (
                <li key={field}>
                  <Badge variant="outline">{field}</Badge>
                </li>
              ))}
            </ul>
          </div>
        )}
        <Button asChild variant={done ? 'outline' : 'default'} size="sm" className="w-fit">
          <Link to="/profil">
            <UserRound data-icon="inline-start" />
            {done ? 'Lihat profil' : 'Lengkapi profil'}
          </Link>
        </Button>
      </div>
    </SectionCard>
  );
}

function RecentDocumentsCard({ items, loading }: { items: Parameters<typeof recentUploads>[0] | undefined; loading: boolean }) {
  const recent = items ? recentUploads(items, 4) : [];
  return (
    <SectionCard
      title="Dokumen terbaru"
      flush
      action={
        <Button asChild variant="ghost" size="sm">
          <Link to="/dokumen">Semua</Link>
        </Button>
      }
    >
      {loading ? (
        <div className="flex flex-col gap-2 p-5" aria-busy="true" aria-label="Memuat dokumen">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : recent.length === 0 ? (
        <EmptyState icon={FileText} size="inline" title="Belum ada dokumen" description="Dokumen yang Anda unggah tampil di sini." />
      ) : (
        <ul className="divide-y">
          {recent.map((item) => {
            const Icon = fileKind(item.arsip.mimeType) === 'image' ? FileImage : FileText;
            return (
              <li key={item.jenisDokumenId}>
                <Link
                  to={`/dokumen?jenis=${encodeURIComponent(item.jenisDokumenId)}`}
                  className="flex items-center gap-3 px-5 py-3 outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                >
                  <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium">{item.nama}</span>
                    <time dateTime={item.arsip.uploadedAt} title={formatDateTimeWITA(item.arsip.uploadedAt)} className="text-xs text-muted-foreground">
                      {formatRelative(item.arsip.uploadedAt)}
                    </time>
                  </span>
                  <StatusBadge status={item.status} iconOnly />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}

function PengajuanCard({ data }: { data: DashboardResponse }) {
  const aktif = data.pengajuanAktif;
  return (
    <SectionCard title="Perubahan data kepegawaian">
      {aktif ? (
        <div className="flex flex-col gap-3">
          <div className={cn('flex gap-2.5 rounded-lg border border-status-pending/25 p-3 text-sm', TONE_CLASSES.pending.soft)}>
            <FileClock className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <p>
              <span className="font-medium">Sedang diverifikasi.</span>{' '}
              <span className="text-foreground">Dikirim {formatRelative(aktif.createdAt)}.</span>
            </p>
          </div>
          <Button asChild variant="outline" size="sm" className="w-fit">
            <Link to="/profil#kepegawaian">Lihat pengajuan</Link>
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">Pangkat, jabatan, atau unit berubah? Ajukan agar diperbarui oleh Admin TU.</p>
          <Button asChild variant="outline" size="sm" className="w-fit">
            <Link to="/profil#kepegawaian">Ajukan perubahan</Link>
          </Button>
        </div>
      )}
    </SectionCard>
  );
}

function DashboardSkeleton() {
  return (
    <div className="grid gap-6 lg:grid-cols-3" aria-busy="true" aria-label="Memuat ringkasan">
      <div className="flex flex-col gap-6 lg:col-span-2">
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-72 rounded-xl" />
      </div>
      <div className="flex flex-col gap-6">
        <Skeleton className="h-48 rounded-xl" />
        <Skeleton className="h-56 rounded-xl" />
      </div>
    </div>
  );
}
