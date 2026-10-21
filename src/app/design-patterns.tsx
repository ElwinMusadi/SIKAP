// Pattern-library showcase for /_design (dev only). Fictitious data only.
import { useMemo, useState } from 'react';
import { ClipboardCheck, FileUp, FolderOpen, MoreHorizontal, Plus, ShieldCheck, Upload, Users } from 'lucide-react';
import { KpiCard } from '@/components/kpi-card';
import { PageHeader } from '@/components/page-header';
import { ProgressMeter } from '@/components/progress-meter';
import { SectionCard } from '@/components/section-card';
import { EmptyState, ErrorState } from '@/components/states';
import { StatusBadge, StatusDot } from '@/components/status-badge';
import { Timeline } from '@/components/timeline';
import { DataTable, SortableHeader, columnHelper, type DataTableColumn } from '@/components/data-table/data-table';
import { FilterBar } from '@/components/data-table/filter-bar';
import { DataTablePagination } from '@/components/data-table/pagination';
import { EntitySheet, FormDialog, FormSection, LockedHint, StickySaveBar } from '@/components/form-patterns';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { STATUS_REGISTRY, type StatusDomain } from '@/lib/status';

interface DemoRow {
  id: string;
  nama: string;
  nip: string;
  status: 'PNS' | 'CPNS' | 'PPPK';
  unit: string;
  verified: number;
  pending: number;
  rejected: number;
  total: number;
}

const UNITS = ['Sub Bagian TU', 'Seksi Penetapan', 'Seksi Penagihan', 'Seksi Pelayanan'];
const STATUSES: DemoRow['status'][] = ['PNS', 'CPNS', 'PPPK'];
const ROWS: DemoRow[] = Array.from({ length: 23 }, (_, i) => {
  const total = 9;
  const verified = (i * 7) % 10 > total ? total : (i * 7) % 10;
  const pending = Math.min(total - verified, i % 3);
  const rejected = Math.min(total - verified - pending, i % 4 === 0 ? 1 : 0);
  return {
    id: String(i + 1),
    nama: `Pegawai Contoh ${String(i + 1).padStart(2, '0')}`,
    nip: `19900101202001${String(1000 + i).slice(-4)}`,
    status: STATUSES[i % 3]!,
    unit: UNITS[i % UNITS.length]!,
    verified,
    pending,
    rejected,
    total,
  };
});

const col = columnHelper<DemoRow>();

function DemoTable() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [unit, setUnit] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const filtered = useMemo(
    () =>
      ROWS.filter(
        (r) =>
          (!q || r.nama.toLowerCase().includes(q.toLowerCase()) || r.nip.includes(q)) &&
          (!status || r.status === status) &&
          (!unit || r.unit === unit),
      ),
    [q, status, unit],
  );
  const pageRows = filtered.slice((page - 1) * pageSize, page * pageSize);
  const reset = () => {
    setQ('');
    setStatus(null);
    setUnit(null);
    setPage(1);
  };

  const columns = useMemo<DataTableColumn<DemoRow>[]>(
    () => [
      col.accessor('nama', {
        header: ({ column }) => <SortableHeader column={column} title="Pegawai" />,
        cell: ({ row }) => (
          <div className="flex flex-col">
            <span className="font-medium">{row.original.nama}</span>
            <span className="text-xs text-muted-foreground tabular-nums">{row.original.nip}</span>
          </div>
        ),
      }),
      col.accessor('status', { header: 'Status', cell: (info) => info.getValue() }),
      col.accessor('unit', { header: 'Unit', meta: { headerClassName: 'hidden lg:table-cell', cellClassName: 'hidden lg:table-cell text-muted-foreground' } }),
      col.display({
        id: 'kelengkapan',
        header: 'Kelengkapan',
        cell: ({ row }) => (
          <ProgressMeter
            variant="compact"
            counts={{
              terverifikasi: row.original.verified,
              menunggu: row.original.pending,
              ditolak: row.original.rejected,
              belum: row.original.total - row.original.verified - row.original.pending - row.original.rejected,
            }}
          />
        ),
      }),
      col.display({
        id: 'aksi',
        header: () => <span className="sr-only">Aksi</span>,
        meta: { headerClassName: 'w-12' },
        cell: () => (
          <Button variant="ghost" size="icon-sm" aria-label="Aksi">
            <MoreHorizontal />
          </Button>
        ),
      }),
    ],
    [],
  );

  return (
    <div className="flex flex-col gap-4">
      <FilterBar
        search={{ value: q, onChange: (v) => (setQ(v), setPage(1)), placeholder: 'Cari nama atau NIP' }}
        facets={[
          {
            id: 'status',
            label: 'Status',
            value: status,
            onChange: (v) => (setStatus(v), setPage(1)),
            options: STATUSES.map((s) => ({ value: s, label: s, count: ROWS.filter((r) => r.status === s).length })),
          },
          { id: 'unit', label: 'Unit', value: unit, onChange: (v) => (setUnit(v), setPage(1)), options: UNITS.map((u) => ({ value: u, label: u })) },
        ]}
        onReset={reset}
        actions={
          <Button size="sm">
            <Plus data-icon="inline-start" />
            Tambah pegawai
          </Button>
        }
      />
      <DataTable
        label="Contoh daftar pegawai"
        data={pageRows}
        columns={columns}
        getRowId={(r) => r.id}
        empty={{ icon: Users, title: 'Belum ada pegawai', description: 'Tambahkan pegawai pertama.' }}
        filtered={Boolean(q || status || unit)}
        onResetFilters={reset}
        mobileCard={(r) => (
          <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-card">
            <div className="flex flex-col">
              <span className="font-medium">{r.nama}</span>
              <span className="text-xs text-muted-foreground tabular-nums">{r.nip}</span>
            </div>
            <ProgressMeter
              variant="compact"
              counts={{ terverifikasi: r.verified, menunggu: r.pending, ditolak: r.rejected, belum: r.total - r.verified - r.pending - r.rejected }}
            />
          </div>
        )}
        footer={
          <DataTablePagination
            page={page}
            pageSize={pageSize}
            total={filtered.length}
            onPageChange={setPage}
            pageSizes={[10, 20, 50]}
            onPageSizeChange={(s) => (setPageSize(s), setPage(1))}
          />
        }
      />
    </div>
  );
}

function OverlayDemos() {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" onClick={() => setSheetOpen(true)}>
        EntitySheet (&gt; 6 bidang)
      </Button>
      <Button variant="outline" onClick={() => setDialogOpen(true)}>
        FormDialog (≤ 6 bidang)
      </Button>
      <EntitySheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        title="Ubah data pegawai"
        description="Perubahan langsung berlaku setelah disimpan."
        footer={
          <>
            <Button variant="outline" onClick={() => setSheetOpen(false)}>
              Batal
            </Button>
            <Button onClick={() => setSheetOpen(false)}>Simpan perubahan</Button>
          </>
        }
      >
        <div className="flex flex-col gap-8">
          <FormSection title="Identitas" description="Sesuai dokumen kependudukan.">
            <Field>
              <FieldLabel htmlFor="demo-nama">Nama lengkap</FieldLabel>
              <Input id="demo-nama" defaultValue="Pegawai Contoh 01" />
            </Field>
            <Field>
              <FieldLabel htmlFor="demo-nip" className="flex items-center gap-1.5">
                NIP <LockedHint reason="NIP tidak dapat diubah." />
              </FieldLabel>
              <Input id="demo-nip" defaultValue="199001012020011000" disabled />
            </Field>
          </FormSection>
          <FormSection title="Kontak" columns={1}>
            <Field>
              <FieldLabel htmlFor="demo-hp">Nomor HP / WhatsApp</FieldLabel>
              <Input id="demo-hp" placeholder="08xxxxxxxxxx" />
            </Field>
          </FormSection>
        </div>
      </EntitySheet>
      <FormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title="Tolak dokumen"
        description="Alasan dikirim ke pegawai agar dapat memperbaiki dokumennya."
        footer={
          <>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Batal
            </Button>
            <Button variant="destructive" onClick={() => setDialogOpen(false)}>
              Tolak dokumen
            </Button>
          </>
        }
      >
        <Field>
          <FieldLabel htmlFor="demo-alasan">Alasan penolakan</FieldLabel>
          <Textarea id="demo-alasan" placeholder="Contoh: pindaian buram, halaman 2 tidak terbaca." />
        </Field>
      </FormDialog>
    </div>
  );
}

export function PatternsShowcase() {
  const [dirty, setDirty] = useState(true);
  return (
    <div className="flex flex-col gap-10">
      <section className="flex flex-col gap-4">
        <h2 className="text-h2">PageHeader</h2>
        <SectionCard title="Contoh header halaman detail" headingLevel="h3">
          <PageHeader
            back={{ to: '/_design', label: 'Master Data Pegawai' }}
            eyebrow="Detail pegawai"
            title="Pegawai Contoh 01"
            description="NIP 199001012020011000 · Seksi Penetapan"
            meta={
              <>
                <StatusBadge domain="akun" status="Aktif" />
                <StatusBadge domain="kelengkapan" status="Belum Lengkap" />
              </>
            }
            actions={
              <>
                <Button variant="outline" size="icon" aria-label="Aksi lain">
                  <MoreHorizontal />
                </Button>
                <Button>Ubah data</Button>
              </>
            }
          />
        </SectionCard>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-h2">KpiCard dan ProgressMeter</h2>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <KpiCard label="Pegawai aktif" value={46} unit="pegawai" icon={Users} caption="PNS 31 · CPNS 4 · PPPK 11" link={{ to: '/_design', label: 'Lihat daftar' }} />
          <KpiCard label="Menunggu verifikasi" value={4} unit="dokumen" icon={ClipboardCheck} tone="highlight" caption="Terlama 2 hari" link={{ to: '/_design', label: 'Periksa sekarang' }} />
          <KpiCard label="Kelengkapan instansi" value="78" unit="%" icon={ShieldCheck}>
            <ProgressMeter variant="compact" counts={{ terverifikasi: 323, menunggu: 12, ditolak: 3, belum: 76 }} />
          </KpiCard>
          <KpiCard label="Memuat" value="—" icon={FolderOpen} loading />
        </div>
        <SectionCard title="Kelengkapan dokumen wajib" description="Satu visual untuk semua layar.">
          <ProgressMeter counts={{ terverifikasi: 5, menunggu: 2, ditolak: 1, belum: 1 }} />
        </SectionCard>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-h2">Registri status</h2>
        <SectionCard title="Semua status" headingLevel="h3">
          <div className="flex flex-col gap-3">
            {(Object.keys(STATUS_REGISTRY) as StatusDomain[]).map((domain) => (
              <div key={domain} className="flex flex-wrap items-center gap-2">
                <span className="w-24 text-eyebrow text-muted-foreground uppercase">{domain}</span>
                {Object.keys(STATUS_REGISTRY[domain]).map((status) => (
                  <StatusBadge key={status} domain={domain} status={status as never} />
                ))}
              </div>
            ))}
            <div className="flex flex-wrap gap-4 pt-2">
              <StatusDot domain="dokumen" status="Terverifikasi" />
              <StatusDot domain="dokumen" status="Menunggu" />
              <StatusDot domain="dokumen" status="Ditolak" />
              <StatusDot domain="dokumen" status="Belum diunggah" />
            </div>
          </div>
        </SectionCard>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-h2">DataTable, FilterBar, paginasi</h2>
        <DemoTable />
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <SectionCard title="Linimasa aktivitas" action={<Button variant="link" size="sm">Lihat semua</Button>}>
          <Timeline
            items={[
              { id: 1, icon: Upload, title: <><strong className="font-medium">Pegawai Contoh 03</strong> mengunggah SK CPNS</>, meta: '5 menit lalu · 21 Okt 2026, 13.45 WITA' },
              { id: 2, icon: ClipboardCheck, tone: 'verified', title: <><strong className="font-medium">Admin Dev</strong> memverifikasi Ijazah</>, meta: '1 jam lalu' },
              { id: 3, icon: FileUp, tone: 'rejected', title: 'Dokumen KTP ditolak', description: 'Pindaian buram.', meta: 'Kemarin' },
            ]}
          />
        </SectionCard>
        <div className="flex flex-col gap-4">
          <SectionCard title="EmptyState" headingLevel="h3" flush>
            <EmptyState icon={FolderOpen} title="Belum ada dokumen" description="Unggah dokumen wajib pertama Anda." action={<Button size="sm">Unggah dokumen</Button>} />
          </SectionCard>
          <SectionCard title="ErrorState" headingLevel="h3" flush>
            <ErrorState onRetry={() => undefined} />
          </SectionCard>
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-h2">Formulir dan overlay</h2>
        <OverlayDemos />
        <StickySaveBar dirty={dirty} onSave={() => setDirty(false)} onDiscard={() => setDirty(false)} />
      </section>
    </div>
  );
}
