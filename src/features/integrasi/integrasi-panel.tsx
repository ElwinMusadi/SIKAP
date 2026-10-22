// Pengaturan Sistem → Integrasi API: Admin manages the keys other applications (first: PINTU) use
// to read employee data through /api/v1. Plan and decisions: docs/RENCANA-API-INTEGRASI.md.
import { useMemo, useState, type ReactNode } from 'react';
import { KeyRound, Plus, Trash2 } from 'lucide-react';
import { API_RATE_LIMIT, IZIN_API_LABELS, type KunciApiItem } from '@shared/integrasi';
import { DataTable, columnHelper, type DataTableColumn } from '@/components/data-table/data-table';
import { SectionCard } from '@/components/section-card';
import { ErrorState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDateTimeWITA, formatDateWITA, formatRelative } from '@/lib/format';
import { BuatKunciDialog, HapusKunciDialog } from './kunci-api-dialogs';
import { apiBaseUrl, kunciLabel, kunciStatus, sisaHari } from './kunci-api-utils';
import { useKunciApi } from './queries';

const col = columnHelper<KunciApiItem>();

function IzinBadges({ item }: { item: KunciApiItem }) {
  if (item.izin.length === 0) return <span className="text-xs text-muted-foreground">Tanpa izin</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {item.izin.map((i) => (
        <Badge key={i} variant="outline">{IZIN_API_LABELS[i]}</Badge>
      ))}
    </span>
  );
}

function Klien({ item }: { item: KunciApiItem }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="truncate font-medium text-foreground">{item.nama}</span>
      {item.keterangan ? <span className="line-clamp-2 text-xs whitespace-normal text-muted-foreground">{item.keterangan}</span> : null}
      <IzinBadges item={item} />
      <span className="text-xs whitespace-normal text-muted-foreground">
        Dibuat {formatDateWITA(item.createdAt)}
        {item.createdBy.nama ? ` oleh ${item.createdBy.nama}` : ''}
      </span>
    </div>
  );
}

function Masa({ item, nowMs }: { item: KunciApiItem; nowMs: number }) {
  const status = kunciStatus(item.expiresAt, nowMs);
  const sisa = sisaHari(item.expiresAt, nowMs);
  return (
    <div className="flex flex-col items-start gap-1">
      <StatusBadge domain="kunciApi" status={status} />
      <span className="text-xs whitespace-normal text-muted-foreground tabular-nums" title={formatDateTimeWITA(item.expiresAt)}>
        {status === 'Kedaluwarsa' ? `Berakhir ${formatDateWITA(item.expiresAt)}` : `s.d. ${formatDateWITA(item.expiresAt)} (${sisa} hari lagi)`}
      </span>
    </div>
  );
}

function TerakhirDipakai({ item }: { item: KunciApiItem }) {
  if (!item.lastUsedAt) return <span className="text-xs text-muted-foreground">Belum pernah</span>;
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-sm" title={formatDateTimeWITA(item.lastUsedAt)}>{formatRelative(item.lastUsedAt)}</span>
      {item.lastUsedIp ? <span className="font-mono text-xs text-muted-foreground">{item.lastUsedIp}</span> : null}
    </div>
  );
}

function HapusButton({ item, onClick }: { item: KunciApiItem; onClick: () => void }) {
  return (
    <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={onClick}>
      <Trash2 data-icon="inline-start" />
      Hapus<span className="sr-only"> kunci {item.nama}</span>
    </Button>
  );
}

export function IntegrasiPanel() {
  const query = useKunciApi();
  const [buatOpen, setBuatOpen] = useState(false);
  const [hapus, setHapus] = useState<KunciApiItem | null>(null);
  // One clock per render so every row agrees on what "expired" means.
  const nowMs = query.dataUpdatedAt || 0;

  const columns = useMemo<DataTableColumn<KunciApiItem>[]>(
    () => [
      col.accessor('nama', { header: 'Klien', meta: { cellClassName: 'min-w-48 align-top' }, cell: ({ row }) => <Klien item={row.original} /> }),
      col.accessor('idPublik', {
        header: 'ID kunci',
        meta: { headerClassName: 'w-36', cellClassName: 'font-mono text-xs align-top' },
        cell: (info) => kunciLabel(info.getValue()),
      }),
      col.accessor('expiresAt', { header: 'Masa berlaku', meta: { headerClassName: 'w-44', cellClassName: 'align-top' }, cell: ({ row }) => <Masa item={row.original} nowMs={nowMs} /> }),
      col.accessor('lastUsedAt', { header: 'Terakhir dipakai', meta: { headerClassName: 'w-32', cellClassName: 'align-top' }, cell: ({ row }) => <TerakhirDipakai item={row.original} /> }),
      col.display({
        id: 'aksi',
        header: () => <span className="sr-only">Aksi</span>,
        meta: { headerClassName: 'w-20', cellClassName: 'text-right align-top' },
        cell: ({ row }) => <HapusButton item={row.original} onClick={() => setHapus(row.original)} />,
      }),
    ],
    [nowMs],
  );

  const buatButton = (
    <Button size="sm" onClick={() => setBuatOpen(true)}>
      <Plus data-icon="inline-start" />
      Buat kunci API
    </Button>
  );

  let content;
  if (query.isPending) {
    content = <Skeleton className="h-40 w-full rounded-xl" aria-busy="true" aria-label="Memuat kunci API" />;
  } else if (query.isError) {
    content = (
      <Card className="py-0">
        <ErrorState error={query.error} title="Gagal memuat kunci API" onRetry={() => void query.refetch()} retrying={query.isFetching} />
      </Card>
    );
  } else {
    content = (
      <DataTable
        label="Kunci API"
        data={query.data.items}
        columns={columns}
        getRowId={(row) => String(row.id)}
        empty={{
          icon: KeyRound,
          title: 'Belum ada kunci API',
          description: 'Buat kunci untuk aplikasi yang perlu membaca data pegawai, misalnya PINTU.',
          action: buatButton,
        }}
        mobileCard={(item) => (
          <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-card">
            <div className="flex items-start justify-between gap-3">
              <Klien item={item} />
              <HapusButton item={item} onClick={() => setHapus(item)} />
            </div>
            <span className="font-mono text-xs text-muted-foreground">{kunciLabel(item.idPublik)}</span>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <span className="text-eyebrow text-muted-foreground uppercase">Masa berlaku</span>
                <Masa item={item} nowMs={nowMs} />
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-eyebrow text-muted-foreground uppercase">Terakhir dipakai</span>
                <TerakhirDipakai item={item} />
              </div>
            </div>
          </div>
        )}
      />
    );
  }

  return (
    <div className="flex flex-col gap-6" aria-busy={query.isFetching || undefined}>
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            <h3 className="text-h3 text-foreground">Kunci API</h3>
            <p className="text-sm text-muted-foreground">Satu kunci untuk satu aplikasi. Kunci yang dihapus langsung tidak berlaku.</p>
          </div>
          {query.isSuccess && query.data.items.length > 0 ? buatButton : null}
        </div>
        {content}
      </section>
      <CaraPakai />
      <BuatKunciDialog open={buatOpen} onClose={() => setBuatOpen(false)} />
      <HapusKunciDialog item={hapus} onClose={() => setHapus(null)} />
    </div>
  );
}

function Baris({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[10rem_1fr] sm:gap-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm break-words text-foreground">{children}</dd>
    </div>
  );
}

function Kode({ children }: { children: ReactNode }) {
  return <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs break-all">{children}</code>;
}

/** Reference for the developer of the client application; never shows a key. */
function CaraPakai() {
  const base = apiBaseUrl(window.location.origin);
  return (
    <SectionCard title="Cara pakai" description="Untuk pengembang aplikasi klien. Panggil dari server aplikasi, bukan dari browser." headingLevel="h3">
      <dl className="flex flex-col gap-3">
        <Baris label="URL dasar"><Kode>{base}</Kode></Baris>
        <Baris label="Autentikasi"><Kode>Authorization: Bearer &lt;kunci&gt;</Kode></Baris>
        <Baris label="Endpoint">
          <ul className="flex flex-col gap-1.5">
            <li><Kode>GET /ping</Kode> tes koneksi: nama klien, izin, masa berlaku</li>
            <li><Kode>GET /pegawai?q=…</Kode> cari pegawai aktif berdasarkan nama atau NIP (minimal 2 karakter)</li>
            <li><Kode>GET /pegawai/&#123;nip&#125;</Kode> detail satu pegawai, termasuk email dan no HP; setiap panggilan dicatat di Log Aktivitas</li>
          </ul>
        </Baris>
        <Baris label="Batas">{API_RATE_LIMIT.requests} permintaan per menit per kunci; lebih dari itu dijawab 429 dengan header Retry-After.</Baris>
        <Baris label="Ganti kunci">Buat kunci baru, pasang di aplikasi klien, lalu hapus kunci lama. Tidak ada jeda layanan.</Baris>
      </dl>
    </SectionCard>
  );
}
