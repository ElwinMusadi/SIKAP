import { useMemo, useState } from 'react';
import { Check, FilePlus2, FileStack, Info, Pencil } from 'lucide-react';
import { STATUS_KEPEGAWAIAN } from '@shared/enums';
import type { AdminJenisDokumen } from '@shared/administrasi';
import { DataTable, SortableHeader, columnHelper, type DataTableColumn, type SortingState } from '@/components/data-table/data-table';
import { FilterBar } from '@/components/data-table/filter-bar';
import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { JenisDialog, type JenisDialogState } from './jenis-dialog';
import { EMPTY_JENIS_FILTERS, filterJenis, formatMaxSize, type JenisFilters } from './jenis-utils';
import { useAdminJenis } from './queries';

export default function JenisDokumenPage() {
  const query = useAdminJenis();
  const [dialog, setDialog] = useState<JenisDialogState>(null);
  const [filters, setFilters] = useState<JenisFilters>(EMPTY_JENIS_FILTERS);
  const [sorting, setSorting] = useState<SortingState>([{ id: 'urutan', desc: false }]);
  const items = useMemo(() => query.data?.items ?? [], [query.data]);
  const latest = dialog?.mode === 'edit' ? items.find((i) => i.id === dialog.item.id) : undefined;
  const nextUrutan = items.reduce((max, i) => Math.max(max, i.urutan), 0) + 10;
  const kategoriOptions = useMemo(() => [...new Set(items.map((i) => i.kategori))].sort((a, b) => a.localeCompare(b, 'id')), [items]);
  const aktif = items.filter((i) => i.aktif).length;
  const shown = useMemo(() => filterJenis(items, filters), [items, filters]);
  const filtered = filters.q !== '' || filters.kategori !== null || filters.status !== null || filters.wajib !== null;

  const onEdit = (item: AdminJenisDokumen) => setDialog({ mode: 'edit', item });
  const columns = useMemo(() => jenisColumns(onEdit), []);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Jenis Dokumen"
        description="Atur jenis dokumen, batas ukuran, dan kewajiban per status kepegawaian."
        meta={
          query.data ? (
            <span className="text-sm text-muted-foreground tabular-nums">
              {items.length} jenis · {aktif} aktif · {items.length - aktif} nonaktif
            </span>
          ) : null
        }
        actions={
          <Button onClick={() => setDialog({ mode: 'create' })}>
            <FilePlus2 data-icon="inline-start" />
            Tambah jenis
          </Button>
        }
      />

      <p className="flex max-w-3xl gap-2 rounded-lg bg-muted/50 px-3 py-2.5 text-sm text-muted-foreground">
        <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span>
          Perubahan status wajib berlaku surut untuk seluruh pegawai dan langsung memengaruhi persentase kelengkapan. Jenis dokumen tidak dapat
          dihapus; nonaktifkan jika tidak lagi dipakai, arsip yang ada tetap tersimpan.
        </span>
      </p>

      <FilterBar
        search={{ value: filters.q, onChange: (q) => setFilters((f) => ({ ...f, q })), placeholder: 'Cari nama atau ID jenis' }}
        facets={[
          {
            id: 'kategori',
            label: 'Kategori',
            value: filters.kategori,
            onChange: (kategori) => setFilters((f) => ({ ...f, kategori })),
            options: kategoriOptions.map((k) => ({ value: k, label: k, count: items.filter((i) => i.kategori === k).length })),
          },
          {
            id: 'wajib',
            label: 'Wajib untuk',
            value: filters.wajib,
            onChange: (wajib) => setFilters((f) => ({ ...f, wajib })),
            options: STATUS_KEPEGAWAIAN.map((s) => ({ value: s, label: s })),
          },
          {
            id: 'status',
            label: 'Status',
            value: filters.status,
            onChange: (status) => setFilters((f) => ({ ...f, status })),
            options: [
              { value: 'aktif', label: 'Aktif', count: aktif },
              { value: 'nonaktif', label: 'Nonaktif', count: items.length - aktif },
            ],
          },
        ]}
        onReset={() => setFilters(EMPTY_JENIS_FILTERS)}
      />

      <DataTable
        label="Daftar jenis dokumen"
        data={query.isPending ? undefined : shown}
        columns={columns}
        getRowId={(row) => row.id}
        loading={query.isPending}
        skeletonRows={6}
        error={query.isError ? query.error : undefined}
        onRetry={() => void query.refetch()}
        filtered={filtered}
        onResetFilters={() => setFilters(EMPTY_JENIS_FILTERS)}
        sorting={sorting}
        onSortingChange={setSorting}
        empty={{
          icon: FileStack,
          title: 'Belum ada jenis dokumen',
          description: 'Tambahkan jenis dokumen agar pegawai dapat mulai mengunggah arsip.',
          action: (
            <Button size="sm" onClick={() => setDialog({ mode: 'create' })}>
              <FilePlus2 data-icon="inline-start" />
              Tambah jenis
            </Button>
          ),
        }}
        mobileCard={(item) => (
          <div className={cn('flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-card', !item.aktif && 'bg-muted/40')}>
            <div className="flex items-start justify-between gap-3">
              <JenisName item={item} showKategori />
              <StatusBadge domain="aktif" status={item.aktif ? 'Aktif' : 'Nonaktif'} className="shrink-0" />
            </div>
            <p className="text-xs text-muted-foreground tabular-nums">
              Urutan {item.urutan} · maks. {formatMaxSize(item.maxSizeBytes)}
            </p>
            <div className="flex items-center justify-between gap-2">
              <WajibMatrix item={item} />
              <EditButton item={item} onEdit={onEdit} />
            </div>
          </div>
        )}
      />

      <JenisDialog
        state={dialog}
        onClose={() => setDialog(null)}
        latest={latest}
        nextUrutan={nextUrutan}
        onRefetch={async () => {
          const editId = dialog?.mode === 'edit' ? dialog.item.id : null;
          // throwOnError: a failed refetch must surface in the dialog instead of resolving with old data.
          const result = await query.refetch({ throwOnError: true });
          return result.data?.items.find((i) => i.id === editId);
        }}
        kategoriOptions={kategoriOptions}
      />
    </div>
  );
}

const col = columnHelper<AdminJenisDokumen>();

function jenisColumns(onEdit: (item: AdminJenisDokumen) => void): DataTableColumn<AdminJenisDokumen>[] {
  return [
    col.accessor('urutan', {
      header: ({ column }) => <SortableHeader column={column} title="Urutan" />,
      sortFn: 'basic',
      meta: { headerClassName: 'w-24', cellClassName: 'text-muted-foreground tabular-nums' },
      cell: (info) => info.getValue(),
    }),
    col.accessor('nama', {
      header: ({ column }) => <SortableHeader column={column} title="Jenis dokumen" />,
      sortFn: 'text',
      meta: { cellClassName: 'max-w-72' },
      cell: ({ row }) => <JenisName item={row.original} />,
    }),
    col.accessor('kategori', {
      header: ({ column }) => <SortableHeader column={column} title="Kategori" />,
      sortFn: 'text',
      meta: { headerClassName: 'hidden lg:table-cell', cellClassName: 'hidden max-w-48 truncate lg:table-cell' },
      cell: (info) => info.getValue(),
    }),
    col.display({
      id: 'wajib',
      header: 'Wajib untuk',
      cell: ({ row }) => <WajibMatrix item={row.original} />,
    }),
    col.accessor('maxSizeBytes', {
      header: () => <span className="block text-right">Maks.</span>,
      meta: { cellClassName: 'text-right tabular-nums' },
      cell: (info) => formatMaxSize(info.getValue()),
    }),
    col.accessor('aktif', {
      header: 'Status',
      cell: (info) => <StatusBadge domain="aktif" status={info.getValue() ? 'Aktif' : 'Nonaktif'} />,
    }),
    col.display({
      id: 'aksi',
      header: () => <span className="sr-only">Aksi</span>,
      meta: { headerClassName: 'w-24', cellClassName: 'text-right' },
      cell: ({ row }) => <EditButton item={row.original} onEdit={onEdit} />,
    }),
  ];
}

function JenisName({ item, showKategori }: { item: AdminJenisDokumen; showKategori?: boolean }) {
  return (
    <div className={cn('flex min-w-0 flex-col', !item.aktif && 'opacity-75')}>
      <span className="truncate font-medium text-foreground" title={item.nama}>
        {item.nama}
      </span>
      <span className="truncate font-mono text-xs text-muted-foreground">{item.id}</span>
      <span className={cn('truncate text-xs text-muted-foreground', !showKategori && 'lg:hidden')}>{item.kategori}</span>
    </div>
  );
}

/** One chip per status kepegawaian: filled with a check when mandatory, plain when optional. */
function WajibMatrix({ item }: { item: AdminJenisDokumen }) {
  return (
    <ul className="flex flex-wrap gap-1" aria-label={`Wajib untuk: ${item.wajibUntuk.length ? item.wajibUntuk.join(', ') : 'tidak ada'}`}>
      {STATUS_KEPEGAWAIAN.map((status) => {
        const wajib = item.wajibUntuk.includes(status);
        return (
          <li
            key={status}
            aria-hidden="true"
            className={cn(
              'inline-flex h-6 items-center gap-1 rounded-md border px-1.5 text-xs font-medium',
              wajib ? 'border-primary/25 bg-accent-soft text-primary' : 'border-dashed text-muted-foreground',
            )}
          >
            {wajib ? <Check className="size-3" /> : null}
            {status}
          </li>
        );
      })}
    </ul>
  );
}

function EditButton({ item, onEdit }: { item: AdminJenisDokumen; onEdit: (item: AdminJenisDokumen) => void }) {
  return (
    <Button variant="ghost" size="sm" onClick={() => onEdit(item)}>
      <Pencil data-icon="inline-start" />
      Ubah<span className="sr-only"> {item.nama}</span>
    </Button>
  );
}
