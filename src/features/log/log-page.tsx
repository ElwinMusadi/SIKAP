import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, FilterX, History, RefreshCw, Search, TriangleAlert } from 'lucide-react';
import { useSearchParams } from 'react-router';
import { LOG_RESULT, type LogResult } from '@shared/enums';
import { LOG_CATEGORIES, type LogItem } from '@shared/administrasi';
import { DatePicker } from '@/components/date-picker';
import { PageHeader } from '@/components/page-header';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { errorMessage } from '@/lib/api';
import { formatDateTimeWITA } from '@/lib/format';
import { cn } from '@/lib/utils';
import {
  CATEGORY_LABELS,
  EMPTY_LOG_FILTERS,
  RESULT_LABELS,
  actionLabel,
  activeLogFilterCount,
  actorLabel,
  logFiltersToSearch,
  parseLogFilters,
  validateLogFilters,
  type LogFilters,
} from './log-utils';
import { useAuditLog } from './queries';

const ALL = '__all__';
const SEARCH_DEBOUNCE_MS = 300;

const RESULT_TONES: Record<LogResult, string> = {
  SUCCESS: 'border-status-verified/30 bg-status-verified-muted text-status-verified',
  FAILURE: 'border-status-rejected/30 bg-status-rejected-muted text-status-rejected',
  WARNING: 'border-status-pending/30 bg-status-pending-muted text-status-pending',
  PARTIAL: 'border-status-pending/30 bg-status-pending-muted text-status-pending',
};

export default function LogPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const searchKey = searchParams.toString();
  // Stable object per URL so the query key does not churn on unrelated renders.
  const filters = useMemo(() => parseLogFilters(new URLSearchParams(searchKey)), [searchKey]);
  const errors = validateLogFilters(filters);
  const valid = Object.keys(errors).length === 0;
  const query = useAuditLog(filters, valid);

  const update = useCallback(
    (patch: Partial<LogFilters>, replace = false) =>
      setSearchParams((prev) => logFiltersToSearch({ ...parseLogFilters(prev), ...patch }), { replace }),
    [setSearchParams],
  );
  const reset = () => setSearchParams(logFiltersToSearch(EMPTY_LOG_FILTERS));
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  // Next-page failures keep loaded rows; only a failed first page replaces the list.
  const nextPageError = query.isFetchNextPageError ? errorMessage(query.error) : null;
  const filtered = activeLogFilterCount(filters) > 0;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Log Aktivitas" description="Jejak audit tindakan pengguna dan sistem. Waktu ditampilkan dalam WITA." />
      <FilterBar filters={filters} errors={errors} update={update} onReset={reset} />

      {!valid ? null : query.isPending ? (
        <LogSkeleton />
      ) : !query.data ? (
        <Alert variant="destructive" role="alert">
          <TriangleAlert />
          <AlertTitle>Gagal memuat log aktivitas</AlertTitle>
          <AlertDescription>
            <p>{errorMessage(query.error)}</p>
            <Button size="sm" variant="outline" className="mt-2" onClick={() => void query.refetch()} disabled={query.isFetching}>
              {query.isFetching ? <Spinner data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" />}
              Coba lagi
            </Button>
          </AlertDescription>
        </Alert>
      ) : items.length === 0 ? (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">{filtered ? <Search /> : <History />}</EmptyMedia>
            <EmptyTitle>{filtered ? 'Tidak ada log yang cocok' : 'Belum ada aktivitas tercatat'}</EmptyTitle>
            <EmptyDescription>
              {filtered ? 'Ubah kata kunci atau rentang tanggal, atau reset filter.' : 'Aktivitas masuk, perubahan data, dan verifikasi akan muncul di sini.'}
            </EmptyDescription>
          </EmptyHeader>
          {filtered ? (
            <EmptyContent>
              <Button variant="outline" onClick={reset}>
                <FilterX data-icon="inline-start" />
                Reset filter
              </Button>
            </EmptyContent>
          ) : null}
        </Empty>
      ) : (
        <section aria-label="Daftar log aktivitas" aria-busy={query.isFetching || undefined} className="flex flex-col gap-4">
          <LogTable items={items} />
          <LogCards items={items} />
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
        </section>
      )}
    </div>
  );
}

type Update = (patch: Partial<LogFilters>, replace?: boolean) => void;

function FilterBar({ filters, errors, update, onReset }: { filters: LogFilters; errors: Record<string, string>; update: Update; onReset: () => void }) {
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

  const count = activeLogFilterCount(filters);
  const dateError = errors.to ?? errors.from;
  return (
    <div role="search" aria-label="Filter log aktivitas" className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(14rem,1.5fr)_repeat(4,minmax(9rem,1fr))] lg:items-end">
        <Field>
          <FieldLabel htmlFor="log-q">Cari</FieldLabel>
          <InputGroup>
            <InputGroupAddon>
              <Search aria-hidden="true" />
            </InputGroupAddon>
            <InputGroupInput
              id="log-q"
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Nama, NIP, aksi, keterangan"
              maxLength={100}
            />
          </InputGroup>
        </Field>
        <FilterSelect
          id="log-category"
          label="Kategori"
          allLabel="Semua kategori"
          value={filters.category}
          options={LOG_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] }))}
          onChange={(v) => update({ category: v as LogFilters['category'] })}
        />
        <FilterSelect
          id="log-result"
          label="Hasil"
          allLabel="Semua hasil"
          value={filters.result}
          options={LOG_RESULT.map((r) => ({ value: r, label: RESULT_LABELS[r] }))}
          onChange={(v) => update({ result: v as LogFilters['result'] })}
        />
        <Field>
          <FieldLabel htmlFor="log-from">Dari tanggal</FieldLabel>
          <DatePicker id="log-from" value={filters.from} onChange={(v) => update({ from: v })} fromYear={2020} placeholder="Awal" />
        </Field>
        <Field data-invalid={dateError ? true : undefined}>
          <FieldLabel htmlFor="log-to">Sampai tanggal</FieldLabel>
          <DatePicker id="log-to" value={filters.to} onChange={(v) => update({ to: v })} fromYear={2020} placeholder="Akhir" invalid={!!dateError} />
        </Field>
      </div>
      {dateError || errors.q ? (
        <FieldError role="alert">{dateError ?? errors.q}</FieldError>
      ) : null}
      {count > 0 ? (
        <div>
          <Button variant="ghost" size="sm" onClick={onReset}>
            <FilterX data-icon="inline-start" />
            Reset filter ({count})
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function FilterSelect({ id, label, allLabel, value, options, onChange }: {
  id: string;
  label: string;
  allLabel: string;
  value: string | null;
  options: { value: string; label: string }[];
  onChange: (value: string | null) => void;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select value={value ?? ALL} onValueChange={(v) => onChange(v === ALL ? null : v)}>
        <SelectTrigger id={id} className={cn('w-full', value && 'border-primary/50 bg-primary/5')}>
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
    </Field>
  );
}

function ResultBadge({ result }: { result: LogResult }) {
  return (
    <Badge variant="outline" className={RESULT_TONES[result]}>
      {RESULT_LABELS[result] ?? result}
    </Badge>
  );
}

function Actor({ actor }: { actor: LogItem['actor'] }) {
  const { name, detail } = actorLabel(actor);
  return (
    <div className="flex min-w-0 flex-col">
      <span className="truncate font-medium" title={name}>{name}</span>
      {detail || actor.role ? (
        <span className="truncate font-mono text-xs text-muted-foreground tabular-nums">
          {[detail, actor.role].filter(Boolean).join(' · ')}
        </span>
      ) : null}
    </div>
  );
}

/** Plain text only: React escapes the string, never rendered as HTML. */
function Description({ item }: { item: LogItem }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-sm font-medium" title={item.action}>{actionLabel(item.action)}</span>
      {item.description ? <p className="text-sm break-words whitespace-pre-line text-muted-foreground">{item.description}</p> : null}
      {item.targetType ? (
        <span className="text-xs text-muted-foreground">
          Target: {item.targetType}
          {item.targetId ? ` #${item.targetId}` : ''}
        </span>
      ) : null}
    </div>
  );
}

function LogTable({ items }: { items: LogItem[] }) {
  return (
    <Card className="hidden py-0 md:flex">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-44 pl-4">Waktu</TableHead>
            <TableHead className="w-52">Pelaku</TableHead>
            <TableHead>Aktivitas</TableHead>
            <TableHead className="w-28 pr-4">Hasil</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => (
            <TableRow key={item.id} className="align-top">
              <TableCell className="pl-4 text-sm whitespace-nowrap tabular-nums">
                <time dateTime={item.ts}>{formatDateTimeWITA(item.ts)}</time>
              </TableCell>
              <TableCell className="max-w-52">
                <Actor actor={item.actor} />
              </TableCell>
              <TableCell className="whitespace-normal">
                <Description item={item} />
              </TableCell>
              <TableCell className="pr-4">
                <ResultBadge result={item.result} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

function LogCards({ items }: { items: LogItem[] }) {
  return (
    <ul className="flex flex-col gap-3 md:hidden">
      {items.map((item) => (
        <li key={item.id}>
          <Card size="sm" className="gap-3 px-4">
            <div className="flex items-start justify-between gap-3">
              <Actor actor={item.actor} />
              <ResultBadge result={item.result} />
            </div>
            <Description item={item} />
            <time dateTime={item.ts} className="text-xs text-muted-foreground tabular-nums">
              {formatDateTimeWITA(item.ts)}
            </time>
          </Card>
        </li>
      ))}
    </ul>
  );
}

function LogSkeleton() {
  return (
    <Card className="py-0" aria-busy="true" aria-label="Memuat log aktivitas">
      <div className="flex flex-col divide-y">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="flex items-start gap-4 p-4">
            <Skeleton className="hidden h-4 w-32 md:block" />
            <div className="flex w-40 flex-col gap-1.5">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-24" />
            </div>
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-full max-w-md" />
            </div>
            <Skeleton className="h-5 w-16" />
          </div>
        ))}
      </div>
    </Card>
  );
}
