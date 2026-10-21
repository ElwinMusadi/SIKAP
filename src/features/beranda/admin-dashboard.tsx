// Beranda Admin (docs/RENCANA-REDESIGN-UIUX.md §8): KPIs, charts from the existing dashboard API,
// the top of the verification queue, quick actions and the activity timeline. No API changes:
// per-unit completeness and an upload trend need new endpoints and are deferred.
import { Bar, BarChart, Cell, Label, Pie, PieChart, XAxis, YAxis } from 'recharts';
import {
  ArrowRight,
  CircleAlert,
  CircleCheck,
  ClipboardCheck,
  FilePen,
  FileStack,
  Inbox,
  KeyRound,
  ScrollText,
  ShieldCheck,
  UserPlus,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { Link } from 'react-router';
import type { AdminDashboardResponse } from '@shared/pegawai';
import { KpiCard } from '@/components/kpi-card';
import { SectionCard } from '@/components/section-card';
import { EmptyState, ErrorState } from '@/components/states';
import { Timeline, type TimelineItem } from '@/components/timeline';
import { Button } from '@/components/ui/button';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import { Skeleton } from '@/components/ui/skeleton';
import { AdminDashboardSkeleton } from '@/features/beranda/admin-dashboard-skeleton';
import { useAdminDashboard } from '@/features/pegawai/queries';
import { PegawaiAvatar } from '@/features/pegawai/pegawai-ui';
import { useVerifikasiQueue } from '@/features/verifikasi/queries';
import { formatDateTimeWITA, formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';

const STATUS_KEYS = ['PNS', 'CPNS', 'PPPK', 'Belum diisi'] as const;

const komposisiConfig = {
  jumlah: { label: 'Pegawai' },
  PNS: { label: 'PNS', color: 'var(--chart-1)' },
  CPNS: { label: 'CPNS', color: 'var(--chart-2)' },
  PPPK: { label: 'PPPK', color: 'var(--chart-4)' },
  'Belum diisi': { label: 'Belum diisi', color: 'var(--chart-5)' },
} satisfies ChartConfig;

const kelengkapanConfig = {
  jumlah: { label: 'Pegawai' },
  Lengkap: { label: 'Lengkap', color: 'var(--status-verified)' },
  'Belum Lengkap': { label: 'Belum lengkap', color: 'var(--status-pending)' },
  'Perlu Revisi': { label: 'Perlu revisi', color: 'var(--status-rejected)' },
} satisfies ChartConfig;

const RESULT_TONE: Record<string, TimelineItem['tone']> = {
  SUCCESS: 'verified',
  FAILURE: 'rejected',
  WARNING: 'pending',
  PARTIAL: 'pending',
};

export function AdminDashboard() {
  const query = useAdminDashboard();

  if (query.isPending) return <AdminDashboardSkeleton />;
  if (query.isError) {
    return (
      <SectionCard title="Ringkasan instansi" flush>
        <ErrorState error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} />
      </SectionCard>
    );
  }

  const data = query.data;
  const { pegawai, dokumen, pengajuanMenunggu } = data;
  const statusCaption = STATUS_KEYS.filter((k) => k !== 'Belum diisi' || (pegawai.perStatus[k] ?? 0) > 0)
    .map((k) => `${k} ${pegawai.perStatus[k] ?? 0}`)
    .join(' · ');

  return (
    <div className="flex flex-col gap-6">
      <section aria-label="Ringkasan instansi" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Pegawai aktif"
          value={pegawai.aktif}
          unit="pegawai"
          icon={Users}
          caption={pegawai.nonaktif > 0 ? `${statusCaption} · nonaktif ${pegawai.nonaktif}` : statusCaption}
          link={{ to: '/admin/pegawai', label: 'Lihat daftar' }}
        />
        <KpiCard
          label="Menunggu verifikasi"
          value={dokumen.menunggu}
          unit="dokumen"
          icon={ClipboardCheck}
          tone={dokumen.menunggu > 0 ? 'highlight' : 'default'}
          caption={dokumen.menunggu > 0 ? 'Dokumen unggahan pegawai perlu diperiksa.' : 'Antrean kosong.'}
          link={{ to: '/admin/verifikasi', label: dokumen.menunggu > 0 ? 'Periksa sekarang' : 'Buka verifikasi' }}
        />
        <KpiCard
          label="Pengajuan perubahan"
          value={pengajuanMenunggu}
          unit="menunggu"
          icon={FilePen}
          tone={pengajuanMenunggu > 0 ? 'highlight' : 'default'}
          caption={pengajuanMenunggu > 0 ? 'Perubahan data kepegawaian perlu ditinjau.' : 'Tidak ada pengajuan.'}
          link={{ to: '/admin/pengajuan', label: 'Tinjau pengajuan' }}
        />
        <KpiCard
          label="Kelengkapan instansi"
          value={dokumen.persenKelengkapan}
          unit="%"
          icon={ShieldCheck}
          caption={`${dokumen.perKelengkapan.Lengkap ?? 0} pegawai lengkap · ${dokumen.perKelengkapan['Perlu Revisi'] ?? 0} perlu revisi`}
        >
          <div
            className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
            role="img"
            aria-label={`Kelengkapan dokumen wajib instansi ${dokumen.persenKelengkapan} persen`}
          >
            <div
              className={cn('h-full rounded-full', dokumen.persenKelengkapan === 100 ? 'bg-status-verified' : 'bg-primary')}
              style={{ width: `${dokumen.persenKelengkapan}%` }}
            />
          </div>
        </KpiCard>
      </section>

      <div className="grid gap-4 lg:grid-cols-5">
        <KelengkapanChart data={data} className="lg:col-span-3" />
        <KomposisiChart data={data} className="lg:col-span-2" />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <AntreanCard className="lg:col-span-2" />
        <div className="flex flex-col gap-4">
          <QuickActions />
          <KeamananCard total={pegawai.total} passwordDefault={pegawai.passwordDefault} />
        </div>
      </div>

      <SectionCard
        title="Aktivitas terbaru"
        description="Tujuh tindakan terakhir di SIKAP."
        action={
          <Button asChild variant="ghost" size="sm">
            <Link to="/admin/log">
              Lihat log
              <ArrowRight data-icon="inline-end" />
            </Link>
          </Button>
        }
      >
        {data.aktivitasTerbaru.length === 0 ? (
          <EmptyState icon={ScrollText} size="inline" title="Belum ada aktivitas" description="Tindakan pengguna akan tercatat di sini." />
        ) : (
          <Timeline
            items={data.aktivitasTerbaru.map((entry) => ({
              id: entry.id,
              tone: RESULT_TONE[entry.result] ?? 'neutral',
              icon: entry.result === 'SUCCESS' ? CircleCheck : CircleAlert,
              title: (
                <>
                  <span className="font-medium">{entry.actorNama ?? 'Sistem'}</span>{' '}
                  <span className="text-muted-foreground">{entry.description ?? entry.action}</span>
                </>
              ),
              meta: (
                <time dateTime={entry.ts} title={formatDateTimeWITA(entry.ts)}>
                  {formatRelative(entry.ts)}
                  {entry.result !== 'SUCCESS' ? ` · ${entry.result}` : ''}
                </time>
              ),
            }))}
          />
        )}
      </SectionCard>
    </div>
  );
}

function KelengkapanChart({ data, className }: { data: AdminDashboardResponse; className?: string }) {
  const rows = (['Lengkap', 'Belum Lengkap', 'Perlu Revisi'] as const).map((key) => ({
    key,
    label: kelengkapanConfig[key].label,
    jumlah: data.dokumen.perKelengkapan[key] ?? 0,
    fill: `var(--color-${key.replace(' ', '-')})`,
  }));
  const total = rows.reduce((sum, r) => sum + r.jumlah, 0);
  return (
    <SectionCard
      className={className}
      title="Kelengkapan dokumen pegawai"
      description="Jumlah pegawai aktif menurut status kelengkapan dokumen wajib."
    >
      {total === 0 ? (
        <EmptyState icon={Users} size="inline" title="Belum ada pegawai aktif" />
      ) : (
        <ChartContainer
          config={{
            jumlah: kelengkapanConfig.jumlah,
            Lengkap: kelengkapanConfig.Lengkap,
            'Belum-Lengkap': kelengkapanConfig['Belum Lengkap'],
            'Perlu-Revisi': kelengkapanConfig['Perlu Revisi'],
          }}
          className="aspect-auto h-48 w-full"
          aria-label={`Kelengkapan pegawai: ${rows.map((r) => `${r.label} ${r.jumlah}`).join(', ')}`}
          role="img"
        >
          <BarChart data={rows} layout="vertical" margin={{ left: 8, right: 24 }} barCategoryGap={14}>
            <YAxis dataKey="label" type="category" tickLine={false} axisLine={false} width={96} />
            <XAxis type="number" hide allowDecimals={false} />
            <ChartTooltip cursor={{ fill: 'var(--muted)' }} content={<ChartTooltipContent hideLabel nameKey="label" />} />
            <Bar dataKey="jumlah" radius={6} label={{ position: 'right', className: 'fill-foreground text-xs tabular-nums' }}>
              {rows.map((r) => (
                <Cell key={r.key} fill={r.fill} />
              ))}
            </Bar>
          </BarChart>
        </ChartContainer>
      )}
    </SectionCard>
  );
}

function KomposisiChart({ data, className }: { data: AdminDashboardResponse; className?: string }) {
  const rows = STATUS_KEYS.map((key) => ({ key, jumlah: data.pegawai.perStatus[key] ?? 0, fill: `var(--color-${key.replace(' ', '-')})` })).filter(
    (r) => r.jumlah > 0,
  );
  const total = rows.reduce((sum, r) => sum + r.jumlah, 0);
  return (
    <SectionCard className={className} title="Komposisi pegawai" description="Menurut status kepegawaian.">
      {total === 0 ? (
        <EmptyState icon={Users} size="inline" title="Belum ada pegawai" />
      ) : (
        <div className="flex flex-col items-center gap-4 sm:flex-row lg:flex-col xl:flex-row">
          <ChartContainer
            config={{
              jumlah: komposisiConfig.jumlah,
              PNS: komposisiConfig.PNS,
              CPNS: komposisiConfig.CPNS,
              PPPK: komposisiConfig.PPPK,
              'Belum-diisi': komposisiConfig['Belum diisi'],
            }}
            className="aspect-square h-44 shrink-0"
            role="img"
            aria-label={`Komposisi pegawai: ${rows.map((r) => `${r.key} ${r.jumlah}`).join(', ')}`}
          >
            <PieChart>
              <ChartTooltip content={<ChartTooltipContent hideLabel nameKey="key" />} />
              <Pie data={rows} dataKey="jumlah" nameKey="key" innerRadius={52} outerRadius={78} strokeWidth={3} stroke="var(--card)">
                {rows.map((r) => (
                  <Cell key={r.key} fill={r.fill} />
                ))}
                <Label
                  content={({ viewBox }) =>
                    viewBox && 'cx' in viewBox && 'cy' in viewBox ? (
                      <text x={viewBox.cx} y={viewBox.cy} textAnchor="middle" dominantBaseline="middle">
                        <tspan x={viewBox.cx} y={viewBox.cy} className="fill-foreground text-2xl font-semibold tabular-nums">
                          {total}
                        </tspan>
                        <tspan x={viewBox.cx} y={(viewBox.cy ?? 0) + 20} className="fill-muted-foreground text-xs">
                          pegawai
                        </tspan>
                      </text>
                    ) : null
                  }
                />
              </Pie>
            </PieChart>
          </ChartContainer>
          <ul className="flex w-full flex-col gap-2">
            {rows.map((r) => (
              <li key={r.key} className="flex items-center gap-2 text-sm">
                <span aria-hidden="true" className="size-2.5 rounded-full" style={{ background: komposisiConfig[r.key].color }} />
                <span className="flex-1">{r.key}</span>
                <span className="font-medium tabular-nums">{r.jumlah}</span>
                <span className="w-10 text-right text-xs text-muted-foreground tabular-nums">{Math.round((r.jumlah / total) * 100)}%</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </SectionCard>
  );
}

function AntreanCard({ className }: { className?: string }) {
  const query = useVerifikasiQueue(null);
  const items = query.data?.pages[0]?.items.slice(0, 5) ?? [];
  const total = query.data?.pages[0]?.total ?? 0;
  return (
    <SectionCard
      className={className}
      title="Antrean verifikasi"
      description={total > 0 ? `${total} dokumen menunggu, terlama di atas.` : 'Dokumen yang menunggu pemeriksaan.'}
      flush
      action={
        total > 0 ? (
          <Button asChild variant="ghost" size="sm">
            <Link to="/admin/verifikasi">
              Lihat semua
              <ArrowRight data-icon="inline-end" />
            </Link>
          </Button>
        ) : undefined
      }
    >
      {query.isPending ? (
        <div className="flex flex-col gap-3 p-5">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : query.isError ? (
        <ErrorState error={query.error} size="inline" onRetry={() => void query.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState icon={Inbox} size="inline" title="Antrean kosong" description="Tidak ada dokumen yang menunggu verifikasi." />
      ) : (
        <ul className="divide-y">
          {items.map((item) => (
            <li key={item.arsipId} className="flex items-center gap-3 px-5 py-3">
              <PegawaiAvatar nama={item.pegawai.nama} fotoUrl={item.pegawai.fotoUrl} className="size-9" />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium">{item.pegawai.nama}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {item.jenisDokumen.nama}
                  {item.jenisDokumen.wajib ? ' · wajib' : ''}
                </span>
              </div>
              <time
                dateTime={item.uploadedAt}
                title={formatDateTimeWITA(item.uploadedAt)}
                className="hidden shrink-0 text-xs text-muted-foreground sm:block"
              >
                {formatRelative(item.uploadedAt)}
              </time>
              <Button asChild variant="outline" size="sm">
                <Link to={`/admin/verifikasi?arsip=${item.arsipId}`}>Periksa</Link>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

const QUICK_ACTIONS: { to: string; label: string; icon: LucideIcon }[] = [
  { to: '/admin/pegawai?tambah=1', label: 'Tambah pegawai', icon: UserPlus },
  { to: '/admin/verifikasi', label: 'Verifikasi dokumen', icon: ClipboardCheck },
  { to: '/admin/pengajuan', label: 'Tinjau pengajuan', icon: FilePen },
  { to: '/admin/jenis-dokumen', label: 'Kelola jenis dokumen', icon: FileStack },
];

function QuickActions() {
  return (
    <SectionCard title="Aksi cepat" flush>
      <ul className="flex flex-col p-1.5">
        {QUICK_ACTIONS.map((action) => (
          <li key={action.to}>
            <Link
              to={action.to}
              className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="flex size-8 items-center justify-center rounded-lg bg-accent-soft text-primary">
                <action.icon className="size-4" aria-hidden="true" />
              </span>
              <span className="flex-1 font-medium">{action.label}</span>
              <ArrowRight className="size-4 text-muted-foreground" aria-hidden="true" />
            </Link>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

function KeamananCard({ total, passwordDefault }: { total: number; passwordDefault: number }) {
  return (
    <KpiCard
      label="Password default"
      value={passwordDefault}
      unit={`dari ${total} akun`}
      icon={KeyRound}
      tone={passwordDefault > 0 ? 'highlight' : 'default'}
      caption={passwordDefault > 0 ? 'Mudah ditebak (6 digit terakhir NIP). Ingatkan pegawai untuk mengganti.' : 'Semua akun sudah mengganti password.'}
      link={passwordDefault > 0 ? { to: '/admin/pegawai?passwordDefault=true', label: 'Lihat daftar' } : undefined}
    />
  );
}
