import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, Eye, KeyRound, MoreHorizontal, Pencil, Undo2, UserPlus, Users, UserX } from 'lucide-react';
import { Link, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { STATUS_AKUN, STATUS_KEPEGAWAIAN } from '@shared/enums';
import { KELENGKAPAN, PAGE_SIZES, type PegawaiListItem, type PegawaiSort } from '@shared/pegawai';
import { DataTable, columnHelper, type DataTableColumn } from '@/components/data-table/data-table';
import { FilterBar } from '@/components/data-table/filter-bar';
import { DataTablePagination } from '@/components/data-table/pagination';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useMe } from '@/features/auth/queries';
import { useRefData } from '@/features/profil/queries';
import { errorMessage } from '@/lib/api';
import { formatDateTimeWITA, formatRelative } from '@/lib/format';
import { STATUS_REGISTRY } from '@/lib/status';
import { cn } from '@/lib/utils';
import { ACTION_META, availableActions, useAccountActionDialog, type AccountAction } from './account-actions';
import { PegawaiFormSheet } from './pegawai-form-sheet';
import { AkunFlags, KelengkapanCell, PegawaiAvatar, RoleBadge, StatusKepegawaianBadge } from './pegawai-ui';
import {
  activeFilterCount,
  clearFilters,
  listParamsToSearch,
  parseListParams,
  patchListParams,
  toggleSort,
  type PageSize,
  type PegawaiListParams,
} from './pegawai-utils';
import { usePegawaiList, useRestorePegawai } from './queries';

const SEARCH_DEBOUNCE_MS = 300;

type Update = (patch: Partial<PegawaiListParams>, replace?: boolean) => void;

export default function PegawaiListPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const params = parseListParams(searchParams);
  const query = usePegawaiList(params);
  const [sheet, setSheet] = useState<{ open: boolean; id: number | null }>({ open: false, id: null });
  const { data: me } = useMe();
  const actions = useAccountActionDialog();

  const update: Update = useCallback(
    (patch, replace = false) => setSearchParams((prev) => listParamsToSearch(patchListParams(parseListParams(prev), patch)), { replace }),
    [setSearchParams],
  );

  // Deep link from Beranda / ⌘K: /admin/pegawai?tambah=1 opens the create sheet once.
  const wantsCreate = searchParams.get('tambah') === '1';
  const [createHandled, setCreateHandled] = useState(false);
  if (wantsCreate && !createHandled) {
    // Adjust state during render (no effect round-trip); the effect below only cleans the URL.
    setCreateHandled(true);
    setSheet({ open: true, id: null });
  }
  useEffect(() => {
    if (!wantsCreate) return;
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('tambah');
        return next;
      },
      { replace: true },
    );
  }, [wantsCreate, setSearchParams]);

  const data = query.data;
  const summary = data?.summary;

  // A filter/delete can leave the current page past the end: jump to the last page that exists.
  const lastPage = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const outOfRange = !!data && !query.isPlaceholderData && data.items.length === 0 && params.page > lastPage;
  useEffect(() => {
    if (outOfRange) setSearchParams((prev) => listParamsToSearch({ ...parseListParams(prev), page: lastPage }), { replace: true });
  }, [outOfRange, lastPage, setSearchParams]);

  const resetFilters = () => setSearchParams(listParamsToSearch(clearFilters(params)));
  const openCreate = () => setSheet({ open: true, id: null });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Master Data Pegawai"
        description="Kelola data, akun, dan kelengkapan dokumen pegawai."
        meta={
          summary ? (
            <p className="text-sm text-muted-foreground tabular-nums">
              <span className="font-medium text-foreground">{summary.total}</span> pegawai · {summary.aktif} aktif · {summary.nonaktif}{' '}
              nonaktif · {summary.passwordDefault} masih password default
            </p>
          ) : null
        }
        actions={
          <Button onClick={openCreate}>
            <UserPlus data-icon="inline-start" />
            Tambah pegawai
          </Button>
        }
      />

      <Tabs value={params.terhapus ? 'terhapus' : 'aktif'} onValueChange={(v) => update({ terhapus: v === 'terhapus' })} className="gap-4">
        <TabsList>
          <TabsTrigger value="aktif">Aktif</TabsTrigger>
          <TabsTrigger value="terhapus">
            Terhapus
            {summary && summary.terhapus > 0 ? (
              <span className="rounded-full bg-muted px-1.5 text-xs text-muted-foreground tabular-nums">{summary.terhapus}</span>
            ) : null}
          </TabsTrigger>
        </TabsList>

        {/* forceMount keeps both panels in the DOM so each tab's aria-controls resolves; only the active one has content. */}
        <TabsContent value="aktif" forceMount className="flex flex-col gap-4 data-[state=inactive]:hidden">
          {params.terhapus ? null : (
            <>
              <PegawaiFilters params={params} update={update} onReset={resetFilters} />
              <AktifTable
                params={params}
                update={update}
                query={query}
                selfId={me?.id}
                onReset={resetFilters}
                onAdd={openCreate}
                onEdit={(id) => setSheet({ open: true, id })}
                onAction={(item, action) => actions.request(item, action)}
              />
            </>
          )}
        </TabsContent>
        <TabsContent value="terhapus" forceMount className="flex flex-col gap-4 data-[state=inactive]:hidden">
          {params.terhapus ? (
            <>
              <PegawaiFilters params={params} update={update} onReset={resetFilters} />
              <TerhapusTable params={params} update={update} query={query} onReset={resetFilters} />
            </>
          ) : null}
        </TabsContent>
      </Tabs>

      <PegawaiFormSheet open={sheet.open} pegawaiId={sheet.id} onOpenChange={(open) => setSheet((s) => ({ ...s, open }))} />
      {actions.dialog}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Filters                                                                    */
/* -------------------------------------------------------------------------- */

function PegawaiFilters({ params, update, onReset }: { params: PegawaiListParams; update: Update; onReset: () => void }) {
  const refQuery = useRefData();
  const [search, setSearch] = useState(params.q);
  const [syncedQ, setSyncedQ] = useState(params.q);
  // Back/forward or "reset filter" changed the URL: reflect it in the input (adjust state during render).
  if (params.q !== syncedQ) {
    setSyncedQ(params.q);
    setSearch(params.q);
  }

  useEffect(() => {
    const next = search.trim();
    if (next === params.q) return;
    // Typing replaces the history entry instead of pushing one per keystroke.
    const timer = window.setTimeout(() => update({ q: next }, true), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [search, params.q, update]);

  const jenisOptions = (refQuery.data?.jenisDokumen ?? []).filter((j) => j.wajibUntuk.length > 0).map((j) => ({ value: j.id, label: j.nama }));

  return (
    <div role="search" aria-label="Filter pegawai">
      <FilterBar
        search={{ value: search, onChange: setSearch, placeholder: 'Cari nama atau NIP' }}
        facets={[
          {
            id: 'statusKepegawaian',
            label: 'Status',
            value: params.statusKepegawaian,
            onChange: (v) => update({ statusKepegawaian: v as PegawaiListParams['statusKepegawaian'] }),
            options: STATUS_KEPEGAWAIAN.map((s) => ({ value: s, label: s })),
          },
          {
            id: 'statusAkun',
            label: 'Akun',
            value: params.statusAkun,
            onChange: (v) => update({ statusAkun: v as PegawaiListParams['statusAkun'] }),
            options: STATUS_AKUN.map((s) => ({ value: s, label: STATUS_REGISTRY.akun[s].label })),
          },
          {
            id: 'kelengkapan',
            label: 'Kelengkapan',
            value: params.kelengkapan,
            onChange: (v) => update({ kelengkapan: v as PegawaiListParams['kelengkapan'] }),
            options: KELENGKAPAN.map((k) => ({ value: k, label: STATUS_REGISTRY.kelengkapan[k].label })),
          },
          {
            id: 'belumUnggah',
            label: 'Belum unggah',
            value: params.belumUnggah,
            onChange: (v) => update({ belumUnggah: v }),
            options: jenisOptions,
          },
        ]}
        extra={
          <Button
            variant="outline"
            size="sm"
            aria-pressed={params.passwordDefault}
            onClick={() => update({ passwordDefault: !params.passwordDefault })}
            className={cn(
              'bg-card font-normal',
              params.passwordDefault ? 'border-primary/40 bg-accent-soft font-medium text-primary' : 'border-dashed',
            )}
          >
            <KeyRound data-icon="inline-start" />
            Password default
          </Button>
        }
        onReset={activeFilterCount(params) > 0 ? onReset : undefined}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Aktif table                                                                */
/* -------------------------------------------------------------------------- */

const col = columnHelper<PegawaiListItem>();

function SortToggle({ field, label, params, update }: { field: PegawaiSort; label: string; params: PegawaiListParams; update: Update }) {
  const active = params.sort === field;
  const Icon = !active ? ArrowUpDown : params.dir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <Button
      variant="ghost"
      size="xs"
      className={cn('-mx-2 text-eyebrow text-muted-foreground uppercase hover:text-foreground', active && 'text-foreground')}
      onClick={() => update(toggleSort(params, field))}
    >
      {label}
      <Icon data-icon="inline-end" aria-hidden="true" className={cn(!active && 'opacity-50')} />
      <span className="sr-only">{active ? `, diurutkan ${params.dir === 'asc' ? 'naik' : 'turun'}` : ', klik untuk mengurutkan'}</span>
    </Button>
  );
}

interface AktifTableProps {
  params: PegawaiListParams;
  update: Update;
  query: ReturnType<typeof usePegawaiList>;
  selfId: number | undefined;
  onReset: () => void;
  onAdd: () => void;
  onEdit: (id: number) => void;
  onAction: (item: PegawaiListItem, action: AccountAction) => void;
}

function AktifTable({ params, update, query, selfId, onReset, onAdd, onEdit, onAction }: AktifTableProps) {
  const columns = useMemo<DataTableColumn<PegawaiListItem>[]>(
    () => [
      col.accessor('nama', {
        id: 'nama',
        header: () => (
          <span className="flex items-center gap-2">
            <SortToggle field="nama" label="Pegawai" params={params} update={update} />
            <span aria-hidden="true" className="text-muted-foreground/60">
              /
            </span>
            <SortToggle field="nip" label="NIP" params={params} update={update} />
          </span>
        ),
        cell: ({ row }) => <PegawaiIdentity item={row.original} />,
      }),
      col.accessor('statusKepegawaian', {
        header: 'Status',
        cell: ({ row }) => (
          <div className="flex flex-col items-start gap-1">
            <StatusKepegawaianBadge status={row.original.statusKepegawaian} />
            {row.original.pangkatKode ? <span className="text-xs text-muted-foreground">{row.original.pangkatKode}</span> : null}
          </div>
        ),
      }),
      col.accessor('jabatan', {
        header: 'Jabatan',
        meta: { headerClassName: 'hidden xl:table-cell', cellClassName: 'hidden max-w-56 xl:table-cell' },
        cell: (info) => (
          <span className="block truncate" title={info.getValue() ?? undefined}>
            {info.getValue() ?? <span className="text-muted-foreground">—</span>}
          </span>
        ),
      }),
      col.display({
        id: 'kelengkapan',
        header: () => <SortToggle field="kelengkapan" label="Kelengkapan" params={params} update={update} />,
        cell: ({ row }) => <KelengkapanCell dokumen={row.original.dokumen} />,
      }),
      col.display({
        id: 'akun',
        header: 'Akun',
        meta: { headerClassName: 'hidden lg:table-cell', cellClassName: 'hidden lg:table-cell' },
        cell: ({ row }) => <AkunFlags item={row.original} />,
      }),
      col.display({
        id: 'aksi',
        header: () => <span className="sr-only">Aksi</span>,
        meta: { headerClassName: 'w-12', cellClassName: 'text-right' },
        cell: ({ row }) => <RowActions item={row.original} selfId={selfId} onEdit={onEdit} onAction={onAction} />,
      }),
    ],
    [params, update, selfId, onEdit, onAction],
  );

  const data = query.data;
  const filtered = activeFilterCount(params) > 0;
  return (
    <DataTable
      label="Daftar pegawai"
      data={data?.items}
      columns={columns}
      getRowId={(item) => String(item.id)}
      loading={query.isPending}
      error={query.isError ? query.error : undefined}
      onRetry={() => void query.refetch()}
      manualSorting
      manualPagination
      sorting={[{ id: params.sort === 'nip' ? 'nama' : params.sort, desc: params.dir === 'desc' }]}
      filtered={filtered}
      onResetFilters={onReset}
      empty={{
        icon: Users,
        title: 'Belum ada pegawai',
        description: 'Tambahkan pegawai pertama. Akun dibuat otomatis dengan password default 6 digit terakhir NIP.',
        action: (
          <Button onClick={onAdd}>
            <UserPlus data-icon="inline-start" />
            Tambah pegawai
          </Button>
        ),
      }}
      className={cn('transition-opacity', query.isPlaceholderData && 'opacity-60')}
      mobileCard={(item) => (
        <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-card">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <PegawaiIdentity item={item} />
            </div>
            <RowActions item={item} selfId={selfId} onEdit={onEdit} onAction={onAction} />
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusKepegawaianBadge status={item.statusKepegawaian} />
            <AkunFlags item={item} />
          </div>
          <KelengkapanCell dokumen={item.dokumen} />
        </div>
      )}
      footer={
        data && data.total > 0 ? (
          <DataTablePagination
            page={data.page}
            pageSize={data.pageSize}
            total={data.total}
            busy={query.isPlaceholderData}
            onPageChange={(page) => update({ page })}
            pageSizes={PAGE_SIZES}
            onPageSizeChange={(size) => update({ pageSize: size as PageSize })}
          />
        ) : null
      }
    />
  );
}

function PegawaiIdentity({ item }: { item: PegawaiListItem }) {
  return (
    <div className="flex items-center gap-3">
      <PegawaiAvatar nama={item.nama} fotoUrl={item.fotoUrl} className="size-9" />
      <div className="flex min-w-0 flex-col">
        <span className="flex items-center gap-2">
          <Link
            to={`/admin/pegawai/${item.id}`}
            className="max-w-64 truncate py-0.5 font-medium text-foreground underline-offset-4 outline-none hover:underline focus-visible:underline"
            title={item.nama}
          >
            {item.nama}
          </Link>
          <RoleBadge role={item.role} />
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">{item.nip}</span>
      </div>
    </div>
  );
}

function RowActions({
  item,
  selfId,
  onEdit,
  onAction,
}: {
  item: PegawaiListItem;
  selfId: number | undefined;
  onEdit: (id: number) => void;
  onAction: (item: PegawaiListItem, action: AccountAction) => void;
}) {
  const allowed = availableActions(item, selfId);
  const account = allowed.filter((a) => a !== 'delete');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`Aksi untuk ${item.nama}`}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem asChild>
          <Link to={`/admin/pegawai/${item.id}`}>
            <Eye />
            Lihat detail
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onEdit(item.id)}>
          <Pencil />
          Ubah data
        </DropdownMenuItem>
        {account.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-eyebrow text-muted-foreground uppercase">Akun</DropdownMenuLabel>
            {account.map((action) => {
              const meta = ACTION_META[action];
              return (
                <DropdownMenuItem key={action} onSelect={() => onAction(item, action)}>
                  <meta.icon />
                  {meta.label}
                </DropdownMenuItem>
              );
            })}
          </>
        ) : null}
        {allowed.includes('delete') ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => onAction(item, 'delete')}>
              <ACTION_META.delete.icon />
              Hapus
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* -------------------------------------------------------------------------- */
/* Terhapus table                                                             */
/* -------------------------------------------------------------------------- */

function RestoreButton({ item }: { item: PegawaiListItem }) {
  const restore = useRestorePegawai();
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={restore.isPending}
      onClick={() =>
        restore.mutate(item.id, {
          onSuccess: () => toast.success(`${item.nama} dipulihkan. Pegawai perlu masuk kembali.`),
          onError: (error) => toast.error(errorMessage(error)),
        })
      }
    >
      {restore.isPending ? <Spinner data-icon="inline-start" /> : <Undo2 data-icon="inline-start" />}
      Pulihkan
      <span className="sr-only"> {item.nama}</span>
    </Button>
  );
}

function DeletedInfo({ item }: { item: PegawaiListItem }) {
  if (!item.deleted) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="flex flex-col gap-0.5 text-sm">
      <span>{formatDateTimeWITA(item.deleted.deletedAt)}</span>
      <span className="text-xs text-muted-foreground">oleh {item.deleted.deletedBy?.nama ?? 'sistem'}</span>
    </div>
  );
}

function PurgeInfo({ item }: { item: PegawaiListItem }) {
  if (!item.deleted) return null;
  return (
    <span className="text-sm font-medium text-status-rejected" title={formatDateTimeWITA(item.deleted.purgeAfter)}>
      Dihapus permanen {formatRelative(item.deleted.purgeAfter)}
    </span>
  );
}

const terhapusCol = columnHelper<PegawaiListItem>();
const TERHAPUS_COLUMNS: DataTableColumn<PegawaiListItem>[] = [
  terhapusCol.accessor('nama', {
    header: 'Pegawai',
    cell: ({ row }) => (
      <div className="flex items-center gap-3">
        <PegawaiAvatar nama={row.original.nama} fotoUrl={null} className="size-9 opacity-60" />
        <div className="flex min-w-0 flex-col">
          <span className="max-w-64 truncate font-medium">{row.original.nama}</span>
          <span className="text-xs text-muted-foreground tabular-nums">{row.original.nip}</span>
        </div>
      </div>
    ),
  }),
  terhapusCol.display({ id: 'dihapus', header: 'Dihapus', cell: ({ row }) => <DeletedInfo item={row.original} /> }),
  terhapusCol.display({ id: 'batas', header: 'Batas pemulihan', cell: ({ row }) => <PurgeInfo item={row.original} /> }),
  terhapusCol.display({
    id: 'aksi',
    header: () => <span className="sr-only">Aksi</span>,
    meta: { cellClassName: 'text-right' },
    cell: ({ row }) => <RestoreButton item={row.original} />,
  }),
];

function TerhapusTable({
  params,
  update,
  query,
  onReset,
}: {
  params: PegawaiListParams;
  update: Update;
  query: ReturnType<typeof usePegawaiList>;
  onReset: () => void;
}) {
  const data = query.data;
  return (
    <DataTable
      label="Pegawai terhapus"
      data={data?.items}
      columns={TERHAPUS_COLUMNS}
      getRowId={(item) => String(item.id)}
      loading={query.isPending}
      error={query.isError ? query.error : undefined}
      onRetry={() => void query.refetch()}
      manualSorting
      manualPagination
      filtered={activeFilterCount(params) > 0}
      onResetFilters={onReset}
      empty={{ icon: UserX, title: 'Tidak ada pegawai terhapus', description: 'Pegawai yang dihapus muncul di sini dan dapat dipulihkan selama 7 hari.' }}
      mobileCard={(item) => (
        <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-card">
          <div className="flex flex-col">
            <span className="truncate font-medium">{item.nama}</span>
            <span className="text-xs text-muted-foreground tabular-nums">{item.nip}</span>
          </div>
          <DeletedInfo item={item} />
          <PurgeInfo item={item} />
          <div>
            <RestoreButton item={item} />
          </div>
        </div>
      )}
      footer={
        data && data.total > 0 ? (
          <DataTablePagination
            page={data.page}
            pageSize={data.pageSize}
            total={data.total}
            busy={query.isPlaceholderData}
            onPageChange={(page) => update({ page })}
            pageSizes={PAGE_SIZES}
            onPageSizeChange={(size) => update({ pageSize: size as PageSize })}
          />
        ) : null
      }
    />
  );
}
