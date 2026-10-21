import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  Eye,
  FilterX,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Search,
  TriangleAlert,
  Undo2,
  UserPlus,
  Users,
  UserX,
} from 'lucide-react';
import { Link, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { STATUS_AKUN, STATUS_KEPEGAWAIAN } from '@shared/enums';
import { KELENGKAPAN, PAGE_SIZES, type PegawaiListItem, type PegawaiListResponse, type PegawaiSort } from '@shared/pegawai';
import { PageHeader } from '@/components/page-header';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useMe } from '@/features/auth/queries';
import { useRefData } from '@/features/profil/queries';
import { errorMessage } from '@/lib/api';
import { formatDateTimeWITA, formatRelative } from '@/lib/format';
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

const ALL = '__all__';
const SEARCH_DEBOUNCE_MS = 300;

export default function PegawaiListPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const params = parseListParams(searchParams);
  const query = usePegawaiList(params);
  const [sheet, setSheet] = useState<{ open: boolean; id: number | null }>({ open: false, id: null });
  const { data: me } = useMe();
  const actions = useAccountActionDialog();

  const update = useCallback(
    (patch: Partial<PegawaiListParams>, replace = false) =>
      setSearchParams((prev) => listParamsToSearch(patchListParams(parseListParams(prev), patch)), { replace }),
    [setSearchParams],
  );

  const summary = query.data?.summary;
  const data = query.data;

  // A filter/delete can leave the current page past the end: jump to the last page that exists.
  const lastPage = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const outOfRange = !!data && !query.isPlaceholderData && data.items.length === 0 && params.page > lastPage;
  useEffect(() => {
    if (outOfRange) setSearchParams((prev) => listParamsToSearch({ ...parseListParams(prev), page: lastPage }), { replace: true });
  }, [outOfRange, lastPage, setSearchParams]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Master Data Pegawai"
        description={
          summary ? (
            <span className="tabular-nums">
              {summary.total} pegawai · {summary.aktif} aktif · {summary.nonaktif} nonaktif · {summary.passwordDefault} masih password
              default
            </span>
          ) : (
            'Kelola data, akun, dan kelengkapan dokumen pegawai.'
          )
        }
        actions={
          <Button onClick={() => setSheet({ open: true, id: null })}>
            <UserPlus data-icon="inline-start" />
            Tambah Pegawai
          </Button>
        }
      />

      <Tabs value={params.terhapus ? 'terhapus' : 'aktif'} onValueChange={(v) => update({ terhapus: v === 'terhapus' })}>
        <TabsList>
          <TabsTrigger value="aktif">Aktif</TabsTrigger>
          <TabsTrigger value="terhapus">
            Terhapus
            {summary ? <span className="text-muted-foreground tabular-nums">({summary.terhapus})</span> : null}
          </TabsTrigger>
        </TabsList>
      </Tabs>

      <FilterBar params={params} update={update} />

      {query.isPending ? (
        <ListSkeleton />
      ) : query.isError ? (
        <Alert variant="destructive" role="alert">
          <TriangleAlert />
          <AlertTitle>Gagal memuat daftar pegawai</AlertTitle>
          <AlertDescription>
            <p>{errorMessage(query.error)}</p>
            <Button size="sm" variant="outline" className="mt-2" onClick={() => void query.refetch()}>
              <RefreshCw data-icon="inline-start" />
              Coba lagi
            </Button>
          </AlertDescription>
        </Alert>
      ) : query.data.items.length === 0 ? (
        <ListEmpty
          params={params}
          data={query.data}
          onAdd={() => setSheet({ open: true, id: null })}
          onClear={() => setSearchParams(listParamsToSearch(clearFilters(params)))}
        />
      ) : (
        <section
          aria-label="Daftar pegawai"
          aria-busy={query.isPlaceholderData || undefined}
          className={cn('flex flex-col gap-4 transition-opacity', query.isPlaceholderData && 'opacity-60')}
        >
          {params.terhapus ? (
            <TerhapusList items={query.data.items} />
          ) : (
            <AktifList
              items={query.data.items}
              params={params}
              selfId={me?.id}
              onSort={(field) => update(toggleSort(params, field))}
              onEdit={(id) => setSheet({ open: true, id })}
              onAction={(item, action) => actions.request(item, action)}
            />
          )}
          <PaginationBar data={query.data} params={params} update={update} />
        </section>
      )}

      <PegawaiFormSheet open={sheet.open} pegawaiId={sheet.id} onOpenChange={(open) => setSheet((s) => ({ ...s, open }))} />
      {actions.dialog}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Filters                                                                    */
/* -------------------------------------------------------------------------- */

type Update = (patch: Partial<PegawaiListParams>, replace?: boolean) => void;

function FilterBar({ params, update }: { params: PegawaiListParams; update: Update }) {
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

  const jenisOptions = (refQuery.data?.jenisDokumen ?? [])
    .filter((j) => j.wajibUntuk.length > 0)
    .map((j) => ({ value: j.id, label: j.nama }));

  return (
    <div className="flex flex-col gap-3" role="search" aria-label="Filter pegawai">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <InputGroup className="lg:max-w-xs">
          <InputGroupAddon>
            <Search aria-hidden="true" />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Cari nama atau NIP"
            aria-label="Cari nama atau NIP"
            maxLength={100}
          />
        </InputGroup>
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
          <FilterSelect
            label="Status kepegawaian"
            allLabel="Semua status"
            value={params.statusKepegawaian}
            options={STATUS_KEPEGAWAIAN.map((s) => ({ value: s, label: s }))}
            onChange={(v) => update({ statusKepegawaian: v as PegawaiListParams['statusKepegawaian'] })}
          />
          <FilterSelect
            label="Status akun"
            allLabel="Semua akun"
            value={params.statusAkun}
            options={STATUS_AKUN.map((s) => ({ value: s, label: `Akun ${s.toLowerCase()}` }))}
            onChange={(v) => update({ statusAkun: v as PegawaiListParams['statusAkun'] })}
          />
          <FilterSelect
            label="Kelengkapan dokumen"
            allLabel="Semua kelengkapan"
            value={params.kelengkapan}
            options={KELENGKAPAN.map((k) => ({ value: k, label: k }))}
            onChange={(v) => update({ kelengkapan: v as PegawaiListParams['kelengkapan'] })}
          />
          <FilterSelect
            label="Belum unggah dokumen"
            allLabel="Belum unggah …"
            value={params.belumUnggah}
            options={jenisOptions.map((o) => ({ value: o.value, label: `Belum unggah ${o.label}` }))}
            onChange={(v) => update({ belumUnggah: v })}
            disabled={refQuery.isPending}
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-2">
          <Switch
            id="filter-password-default"
            checked={params.passwordDefault}
            onCheckedChange={(checked) => update({ passwordDefault: checked })}
          />
          <Label htmlFor="filter-password-default" className="font-normal">
            Masih password default
          </Label>
        </div>
        {activeFilterCount(params) > 0 ? (
          <Button variant="ghost" size="sm" onClick={() => update(clearFilters(params))}>
            <FilterX data-icon="inline-start" />
            Reset filter ({activeFilterCount(params)})
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function FilterSelect({
  label,
  allLabel,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  allLabel: string;
  value: string | null;
  options: { value: string; label: string }[];
  onChange: (value: string | null) => void;
  disabled?: boolean;
}) {
  return (
    <Select value={value ?? ALL} onValueChange={(v) => onChange(v === ALL ? null : v)} disabled={disabled}>
      <SelectTrigger aria-label={label} className={cn('w-full sm:w-auto sm:min-w-40', value && 'border-primary/50 bg-primary/5')}>
        <SelectValue placeholder={allLabel} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{allLabel}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/* -------------------------------------------------------------------------- */
/* Aktif list                                                                 */
/* -------------------------------------------------------------------------- */

interface AktifListProps {
  items: PegawaiListItem[];
  params: PegawaiListParams;
  selfId: number | undefined;
  onSort: (field: PegawaiSort) => void;
  onEdit: (id: number) => void;
  onAction: (item: PegawaiListItem, action: AccountAction) => void;
}

function ariaSort(params: PegawaiListParams, fields: PegawaiSort[]): 'ascending' | 'descending' | undefined {
  if (!fields.includes(params.sort)) return undefined;
  return params.dir === 'asc' ? 'ascending' : 'descending';
}

function SortButton({ field, label, params, onSort }: { field: PegawaiSort; label: string; params: PegawaiListParams; onSort: (f: PegawaiSort) => void }) {
  const active = params.sort === field;
  const Icon = !active ? ArrowUpDown : params.dir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <Button
      variant="ghost"
      size="xs"
      className={cn('-ml-2 text-eyebrow text-muted-foreground uppercase', active && 'text-foreground')}
      onClick={() => onSort(field)}
    >
      {label}
      <Icon data-icon="inline-end" aria-hidden="true" />
      <span className="sr-only">
        {active ? `, diurutkan ${params.dir === 'asc' ? 'naik' : 'turun'}` : ', klik untuk mengurutkan'}
      </span>
    </Button>
  );
}

function AktifList({ items, params, selfId, onSort, onEdit, onAction }: AktifListProps) {
  return (
    <>
      <Card className="hidden py-0 md:flex">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead aria-sort={ariaSort(params, ['nama', 'nip'])} className="pl-4">
                <div className="flex items-center gap-1">
                  <SortButton field="nama" label="Nama" params={params} onSort={onSort} />
                  <span aria-hidden="true" className="text-muted-foreground">
                    /
                  </span>
                  <SortButton field="nip" label="NIP" params={params} onSort={onSort} />
                </div>
              </TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="hidden lg:table-cell">Jabatan</TableHead>
              <TableHead aria-sort={ariaSort(params, ['kelengkapan'])}>
                <SortButton field="kelengkapan" label="Kelengkapan" params={params} onSort={onSort} />
              </TableHead>
              <TableHead>Akun</TableHead>
              <TableHead className="w-12 pr-4">
                <span className="sr-only">Aksi</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <TableRow key={item.id}>
                <TableCell className="pl-4">
                  <div className="flex items-center gap-3">
                    <PegawaiAvatar nama={item.nama} fotoUrl={item.fotoUrl} />
                    <div className="flex min-w-0 flex-col">
                      <span className="flex items-center gap-2">
                        <Link
                          to={`/admin/pegawai/${item.id}`}
                          className="max-w-64 truncate font-medium text-foreground underline-offset-4 hover:underline focus-visible:underline"
                          title={item.nama}
                        >
                          {item.nama}
                        </Link>
                        <RoleBadge role={item.role} />
                      </span>
                      <span className="font-mono text-xs text-muted-foreground tabular-nums">{item.nip}</span>
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  <StatusKepegawaianBadge status={item.statusKepegawaian} />
                </TableCell>
                <TableCell className="hidden max-w-48 lg:table-cell">
                  <span className="block truncate" title={item.jabatan ?? undefined}>
                    {item.jabatan ?? <span className="text-muted-foreground">—</span>}
                  </span>
                </TableCell>
                <TableCell>
                  <KelengkapanCell dokumen={item.dokumen} />
                </TableCell>
                <TableCell>
                  <AkunFlags item={item} />
                </TableCell>
                <TableCell className="pr-4 text-right">
                  <RowActions item={item} selfId={selfId} onEdit={onEdit} onAction={onAction} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      <ul className="flex flex-col gap-3 md:hidden">
        {items.map((item) => (
          <li key={item.id}>
            <Card size="sm">
              <CardContent className="flex flex-col gap-3">
                <div className="flex items-start gap-3">
                  <PegawaiAvatar nama={item.nama} fotoUrl={item.fotoUrl} className="size-10" />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <Link to={`/admin/pegawai/${item.id}`} className="truncate font-medium underline-offset-4 hover:underline">
                      {item.nama}
                    </Link>
                    <span className="font-mono text-xs text-muted-foreground tabular-nums">{item.nip}</span>
                    {item.jabatan ? <span className="truncate text-xs text-muted-foreground">{item.jabatan}</span> : null}
                  </div>
                  <RowActions item={item} selfId={selfId} onEdit={onEdit} onAction={onAction} />
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <StatusKepegawaianBadge status={item.statusKepegawaian} />
                  <RoleBadge role={item.role} />
                  <AkunFlags item={item} />
                </div>
                <KelengkapanCell dokumen={item.dokumen} />
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
    </>
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
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem asChild>
          <Link to={`/admin/pegawai/${item.id}`}>
            <Eye />
            Lihat detail
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onEdit(item.id)}>
          <Pencil />
          Edit
        </DropdownMenuItem>
        {account.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs text-muted-foreground">Akun</DropdownMenuLabel>
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
/* Terhapus list                                                              */
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

function TerhapusList({ items }: { items: PegawaiListItem[] }) {
  return (
    <>
      <Card className="hidden py-0 md:flex">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4">Pegawai</TableHead>
              <TableHead>Dihapus</TableHead>
              <TableHead>Batas pemulihan</TableHead>
              <TableHead className="pr-4 text-right">
                <span className="sr-only">Aksi</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <TableRow key={item.id}>
                <TableCell className="pl-4">
                  <div className="flex items-center gap-3">
                    <PegawaiAvatar nama={item.nama} fotoUrl={null} className="opacity-60" />
                    <div className="flex min-w-0 flex-col">
                      <span className="max-w-64 truncate font-medium">{item.nama}</span>
                      <span className="font-mono text-xs text-muted-foreground tabular-nums">{item.nip}</span>
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  <DeletedInfo item={item} />
                </TableCell>
                <TableCell>
                  <PurgeInfo item={item} />
                </TableCell>
                <TableCell className="pr-4 text-right">
                  <RestoreButton item={item} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
      <ul className="flex flex-col gap-3 md:hidden">
        {items.map((item) => (
          <li key={item.id}>
            <Card size="sm">
              <CardContent className="flex flex-col gap-3">
                <div className="flex flex-col">
                  <span className="truncate font-medium">{item.nama}</span>
                  <span className="font-mono text-xs text-muted-foreground tabular-nums">{item.nip}</span>
                </div>
                <DeletedInfo item={item} />
                <PurgeInfo item={item} />
                <div>
                  <RestoreButton item={item} />
                </div>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Pagination, empty, skeleton                                                */
/* -------------------------------------------------------------------------- */

function PaginationBar({ data, params, update }: { data: PegawaiListResponse; params: PegawaiListParams; update: Update }) {
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const from = data.total === 0 ? 0 : (data.page - 1) * data.pageSize + 1;
  const to = Math.min(data.total, data.page * data.pageSize);
  return (
    <nav aria-label="Navigasi halaman" className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm text-muted-foreground tabular-nums" aria-live="polite">
        Menampilkan {from}–{to} dari {data.total} pegawai
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2">
          <Label htmlFor="page-size" className="text-sm font-normal text-muted-foreground">
            Per halaman
          </Label>
          <Select value={String(params.pageSize)} onValueChange={(v) => update({ pageSize: Number(v) as PageSize })}>
            <SelectTrigger id="page-size" size="sm" className="w-18">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZES.map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" disabled={params.page <= 1} onClick={() => update({ page: params.page - 1 })}>
            <ChevronLeft data-icon="inline-start" />
            Sebelumnya
          </Button>
          <span className="px-2 text-sm tabular-nums" aria-current="page">
            {data.page} / {pages}
          </span>
          <Button variant="outline" size="sm" disabled={params.page >= pages} onClick={() => update({ page: params.page + 1 })}>
            Berikutnya
            <ChevronRight data-icon="inline-end" />
          </Button>
        </div>
      </div>
    </nav>
  );
}

function ListEmpty({
  params,
  data,
  onAdd,
  onClear,
}: {
  params: PegawaiListParams;
  data: PegawaiListResponse;
  onAdd: () => void;
  onClear: () => void;
}) {
  const filtered = activeFilterCount(params) > 0;
  let icon = <Users />;
  let title = 'Belum ada pegawai';
  let description = 'Tambahkan pegawai pertama. Akun dibuat otomatis dengan password default 6 digit terakhir NIP.';
  let action: ReactNode = (
    <Button onClick={onAdd}>
      <UserPlus data-icon="inline-start" />
      Tambah Pegawai
    </Button>
  );
  if (filtered) {
    icon = <Search />;
    title = 'Tidak ada pegawai yang cocok';
    description = params.q ? `Tidak ditemukan pegawai untuk “${params.q}” dengan filter yang dipilih.` : 'Tidak ada pegawai yang sesuai dengan filter yang dipilih.';
    action = (
      <Button variant="outline" onClick={onClear}>
        <FilterX data-icon="inline-start" />
        Reset filter
      </Button>
    );
  } else if (params.terhapus) {
    icon = <UserX />;
    title = 'Tidak ada pegawai terhapus';
    description = 'Pegawai yang dihapus muncul di sini dan dapat dipulihkan selama 7 hari.';
    action = null;
  } else if (data.summary.total > 0) {
    title = 'Halaman ini kosong';
    description = 'Kembali ke halaman pertama untuk melihat daftar pegawai.';
    action = (
      <Button variant="outline" onClick={onClear}>
        Ke halaman pertama
      </Button>
    );
  }
  return (
    <Empty className="border border-dashed">
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon}</EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {action ? <EmptyContent>{action}</EmptyContent> : null}
    </Empty>
  );
}

function ListSkeleton() {
  return (
    <Card className="py-0" aria-busy="true" aria-label="Memuat daftar pegawai">
      <div className="flex flex-col divide-y">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="flex items-center gap-3 p-4">
            <Skeleton className="size-8 rounded-full" />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-3 w-36" />
            </div>
            <Skeleton className="hidden h-5 w-14 md:block" />
            <Skeleton className="hidden h-6 w-36 md:block" />
            <Skeleton className="hidden h-5 w-16 md:block" />
          </div>
        ))}
      </div>
    </Card>
  );
}
