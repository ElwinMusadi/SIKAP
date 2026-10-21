import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, FilePen, FileText, History, KeyRound, Settings, Users, type LucideIcon } from 'lucide-react';
import { useSearchParams } from 'react-router';
import { LOG_RESULT } from '@shared/enums';
import { LOG_CATEGORIES, type LogCategory, type LogItem } from '@shared/administrasi';
import { DataTable, columnHelper, type DataTableColumn } from '@/components/data-table/data-table';
import { FilterBar } from '@/components/data-table/filter-bar';
import { DateRangePicker } from '@/components/date-picker';
import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { FieldError } from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';
import { errorMessage } from '@/lib/api';
import { formatDateTimeWITA, formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';
import {
  CATEGORY_LABELS,
  EMPTY_LOG_FILTERS,
  RESULT_LABELS,
  actionCategory,
  actionLabel,
  activeLogFilterCount,
  actorLabel,
  logFiltersToSearch,
  parseLogFilters,
  validateLogFilters,
  type LogFilters,
} from './log-utils';
import { useAuditLog } from './queries';

const SEARCH_DEBOUNCE_MS = 300;

const CATEGORY_ICON: Record<LogCategory, LucideIcon> = {
  auth: KeyRound,
  pegawai: Users,
  dokumen: FileText,
  pengajuan: FilePen,
  sistem: Settings,
};

type Update = (patch: Partial<LogFilters>, replace?: boolean) => void;

export default function LogPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const searchKey = searchParams.toString();
  // Stable object per URL so the query key does not churn on unrelated renders.
  const filters = useMemo(() => parseLogFilters(new URLSearchParams(searchKey)), [searchKey]);
  const errors = validateLogFilters(filters);
  const valid = Object.keys(errors).length === 0;
  const query = useAuditLog(filters, valid);

  const update: Update = useCallback(
    (patch, replace = false) => setSearchParams((prev) => logFiltersToSearch({ ...parseLogFilters(prev), ...patch }), { replace }),
    [setSearchParams],
  );
  const reset = () => setSearchParams(logFiltersToSearch(EMPTY_LOG_FILTERS));
  const items = query.data?.pages.flatMap((page) => page.items);
  // Next-page failures keep loaded rows; only a failed first page replaces the list.
  const nextPageError = query.isFetchNextPageError ? errorMessage(query.error) : null;
  const filtered = activeLogFilterCount(filters) > 0;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Log Aktivitas" description="Jejak audit tindakan pengguna dan sistem. Waktu ditampilkan dalam WITA." />
      <LogFilterBar filters={filters} errors={errors} update={update} onReset={reset} />

      {valid ? (
        <section aria-label="Daftar log aktivitas" aria-busy={query.isFetching || undefined} className="flex flex-col gap-4">
          <LogTable
            items={query.isPending ? undefined : items}
            loading={query.isPending}
            error={!query.isPending && !query.data ? query.error : undefined}
            onRetry={() => void query.refetch()}
            filtered={filtered}
            onReset={reset}
          />
          {items && items.length > 0 ? (
            <div className="flex flex-col items-center gap-2">
              {nextPageError ? (
                <p role="alert" className="text-sm text-destructive">
                  {nextPageError}
                </p>
              ) : null}
              {query.hasNextPage ? (
                <Button variant="outline" onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>
                  {query.isFetchingNextPage ? <Spinner data-icon="inline-start" /> : <ChevronDown data-icon="inline-start" />}
                  {nextPageError ? 'Coba muat lagi' : 'Muat lebih banyak'}
                </Button>
              ) : null}
              <p className="text-xs text-muted-foreground tabular-nums" aria-live="polite">
                {items.length} entri ditampilkan{query.hasNextPage ? '' : ' · akhir log'}
              </p>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function LogFilterBar({ filters, errors, update, onReset }: { filters: LogFilters; errors: Record<string, string>; update: Update; onReset: () => void }) {
  const [search, setSearch] = useState(filters.q);
  const [syncedQ, setSyncedQ] = useState(filters.q);
  if (filters.q !== syncedQ) {
    setSyncedQ(filters.q);
    setSearch(filters.q);
  }
  useEffect(() => {
    const next = search.trim();
    if (next === filters.q) return;
    const timer = window.setTimeout(() => update({ q: next }, true), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [search, filters.q, update]);

  const dateError = errors.to ?? errors.from;
  return (
    <div role="search" aria-label="Filter log aktivitas" className="flex flex-col gap-2">
      <FilterBar
        search={{ value: search, onChange: setSearch, placeholder: 'Cari nama, NIP, aksi, keterangan' }}
        facets={[
          {
            id: 'category',
            label: 'Kategori',
            value: filters.category,
            onChange: (value) => update({ category: value as LogFilters['category'] }),
            options: LOG_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] })),
          },
          {
            id: 'result',
            label: 'Hasil',
            value: filters.result,
            onChange: (value) => update({ result: value as LogFilters['result'] }),
            options: LOG_RESULT.map((r) => ({ value: r, label: RESULT_LABELS[r] })),
          },
        ]}
        extra={
          <DateRangePicker
            id="log-tanggal"
            size="sm"
            value={{ from: filters.from, to: filters.to }}
            onChange={(range) => update({ from: range.from, to: range.to })}
            invalid={!!dateError}
          />
        }
        onReset={onReset}
      />
      {dateError || errors.q ? <FieldError role="alert">{dateError ?? errors.q}</FieldError> : null}
    </div>
  );
}

function Actor({ actor }: { actor: LogItem['actor'] }) {
  const { name, detail } = actorLabel(actor);
  return (
    <div className="flex min-w-0 flex-col">
      <span className="truncate font-medium" title={name}>
        {name}
      </span>
      {detail || actor.role ? (
        <span className="truncate text-xs text-muted-foreground tabular-nums">{[detail, actor.role].filter(Boolean).join(' · ')}</span>
      ) : null}
    </div>
  );
}

/** Plain text only: React escapes the string, never rendered as HTML. */
function Activity({ item }: { item: LogItem }) {
  const category = actionCategory(item.action);
  const Icon = category ? CATEGORY_ICON[category] : History;
  return (
    <div className="flex min-w-0 items-start gap-2.5">
      <span
        className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
        title={category ? CATEGORY_LABELS[category] : undefined}
      >
        <Icon className="size-3.5" aria-hidden="true" />
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-medium" title={item.action}>
          {actionLabel(item.action)}
        </span>
        {item.description ? <p className="text-sm break-words whitespace-pre-line text-muted-foreground">{item.description}</p> : null}
        {item.targetType ? (
          <span className="text-xs text-muted-foreground">
            Target: {item.targetType}
            {item.targetId ? ` #${item.targetId}` : ''}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function Time({ ts, className }: { ts: string; className?: string }) {
  return (
    <time dateTime={ts} title={formatRelative(ts)} className={cn('text-sm whitespace-nowrap tabular-nums', className)}>
      {formatDateTimeWITA(ts)}
    </time>
  );
}

const col = columnHelper<LogItem>();

const COLUMNS: DataTableColumn<LogItem>[] = [
  col.accessor('ts', {
    header: 'Waktu',
    meta: { headerClassName: 'w-48', cellClassName: 'align-top' },
    cell: (info) => <Time ts={info.getValue()} />,
  }),
  col.display({
    id: 'pelaku',
    header: 'Pelaku',
    meta: { headerClassName: 'w-56', cellClassName: 'max-w-56 align-top' },
    cell: ({ row }) => <Actor actor={row.original.actor} />,
  }),
  col.display({
    id: 'aktivitas',
    header: 'Aktivitas',
    meta: { cellClassName: 'whitespace-normal align-top' },
    cell: ({ row }) => <Activity item={row.original} />,
  }),
  col.accessor('result', {
    header: 'Hasil',
    meta: { headerClassName: 'w-32', cellClassName: 'align-top' },
    cell: (info) => <StatusBadge domain="log" status={info.getValue()} />,
  }),
];

function LogTable({
  items,
  loading,
  error,
  onRetry,
  filtered,
  onReset,
}: {
  items: LogItem[] | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  filtered: boolean;
  onReset: () => void;
}) {
  return (
    <DataTable
      label="Log aktivitas"
      data={items}
      columns={COLUMNS}
      getRowId={(row) => String(row.id)}
      loading={loading}
      skeletonRows={8}
      density="compact"
      error={error}
      onRetry={onRetry}
      filtered={filtered}
      onResetFilters={onReset}
      empty={{ icon: History, title: 'Belum ada aktivitas tercatat', description: 'Aktivitas masuk, perubahan data, dan verifikasi akan muncul di sini.' }}
      mobileCard={(item) => (
        <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-card">
          <div className="flex items-start justify-between gap-3">
            <Actor actor={item.actor} />
            <StatusBadge domain="log" status={item.result} className="shrink-0" />
          </div>
          <Activity item={item} />
          <Time ts={item.ts} className="text-xs text-muted-foreground" />
        </div>
      )}
    />
  );
}
