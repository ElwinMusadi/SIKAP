// The one data table (docs/RENCANA-REDESIGN-UIUX.md §7). TanStack Table v9 with SIKAP defaults:
// sticky tinted header, sortable columns, client- or server-side sorting/paging, an automatic card list
// below md, and built-in loading / empty / no-results / error states.
import { useState, type ReactNode } from 'react';
import {
  columnVisibilityFeature,
  createColumnHelper,
  createPaginatedRowModel,
  createSortedRowModel,
  FlexRender,
  rowPaginationFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_basic,
  sortFn_datetime,
  sortFn_text,
  tableFeatures,
  useTable,
  type CellData,
  type ColumnDef,
  type PaginationState,
  type RowData,
  type SortingState,
  type TableFeatures,
} from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ArrowUpDown, SearchX, type LucideIcon } from 'lucide-react';
import { EmptyState, ErrorState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';

declare module '@tanstack/react-table' {
  // Same type parameters (names included) as the original declaration, as module augmentation requires.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<in out TFeatures extends TableFeatures, in out TData extends RowData, TValue extends CellData = CellData> {
    /** Extra classes for the <th> (width, alignment, responsive hiding). */
    headerClassName?: string;
    /** Extra classes for every <td> of this column. */
    cellClassName?: string;
  }
}

export const dataTableFeatures = tableFeatures({
  columnVisibilityFeature,
  rowSortingFeature,
  rowPaginationFeature,
  sortedRowModel: createSortedRowModel(),
  paginatedRowModel: createPaginatedRowModel(),
  sortFns: {
    alphanumeric: sortFn_alphanumeric,
    basic: sortFn_basic,
    datetime: sortFn_datetime,
    text: sortFn_text,
  },
});

export type DataTableFeatures = typeof dataTableFeatures;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- column value types differ per column.
export type DataTableColumn<T extends RowData> = ColumnDef<DataTableFeatures, T, any>;
export type { SortingState, PaginationState };

export function columnHelper<T extends RowData>() {
  return createColumnHelper<DataTableFeatures, T>();
}

interface SortableColumn {
  getIsSorted: () => false | 'asc' | 'desc';
  toggleSorting: (desc?: boolean) => void;
  getCanSort: () => boolean;
}

/** Clickable column header with the sort direction for sighted and screen-reader users. */
export function SortableHeader({ column, title, align = 'start' }: { column: SortableColumn; title: string; align?: 'start' | 'end' }) {
  const sorted = column.getIsSorted();
  const Icon = sorted === 'asc' ? ArrowUp : sorted === 'desc' ? ArrowDown : ArrowUpDown;
  return (
    <Button
      variant="ghost"
      size="xs"
      className={cn(
        '-mx-2 text-eyebrow text-muted-foreground uppercase hover:text-foreground',
        sorted && 'text-foreground',
        align === 'end' && 'ml-auto',
      )}
      onClick={() => column.toggleSorting(sorted === 'asc')}
    >
      {title}
      <Icon data-icon="inline-end" aria-hidden="true" className={cn(!sorted && 'opacity-50')} />
      <span className="sr-only">
        {sorted === 'asc' ? ', diurutkan naik' : sorted === 'desc' ? ', diurutkan turun' : ', klik untuk mengurutkan'}
      </span>
    </Button>
  );
}

export interface DataTableEmpty {
  icon: LucideIcon;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}

interface DataTableProps<T extends RowData> {
  /** Accessible table name, e.g. "Daftar pegawai". */
  label: string;
  data: T[] | undefined;
  columns: DataTableColumn<T>[];
  getRowId: (row: T) => string;
  loading?: boolean;
  /** Error from the query; shows ErrorState with retry instead of rows. */
  error?: unknown;
  onRetry?: () => void;
  /** Shown when there are no rows and no filter is active. */
  empty: DataTableEmpty;
  /** True when search/filters are active: an empty result then says "no match" with a reset action. */
  filtered?: boolean;
  onResetFilters?: () => void;
  /** Card renderer for screens below md; without it the table scrolls horizontally. */
  mobileCard?: (row: T) => ReactNode;
  /** Controlled sorting (server mode: also set manualSorting). */
  sorting?: SortingState;
  onSortingChange?: (sorting: SortingState) => void;
  manualSorting?: boolean;
  /** Client-side paging page size; ignored when `manualPagination` (the server already paged `data`). */
  pageSize?: number;
  manualPagination?: boolean;
  /** Rendered under the table (usually <DataTablePagination>). */
  footer?: ReactNode;
  onRowClick?: (row: T) => void;
  density?: 'comfortable' | 'compact';
  skeletonRows?: number;
  className?: string;
}

export function DataTable<T extends RowData>({
  label,
  data,
  columns,
  getRowId,
  loading,
  error,
  onRetry,
  empty,
  filtered,
  onResetFilters,
  mobileCard,
  sorting: sortingProp,
  onSortingChange,
  manualSorting,
  pageSize,
  manualPagination,
  footer,
  onRowClick,
  density = 'comfortable',
  skeletonRows = 5,
  className,
}: DataTableProps<T>) {
  const [innerSorting, setInnerSorting] = useState<SortingState>([]);
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: pageSize ?? 1_000_000 });
  const sorting = sortingProp ?? innerSorting;

  const table = useTable({
    features: dataTableFeatures,
    data: data ?? [],
    columns,
    getRowId,
    state: { sorting, pagination },
    manualSorting,
    manualPagination: manualPagination || pageSize === undefined,
    onSortingChange: (updater) => {
      const next = typeof updater === 'function' ? updater(sorting) : updater;
      if (onSortingChange) onSortingChange(next);
      else setInnerSorting(next);
    },
    onPaginationChange: setPagination,
    enableSortingRemoval: false,
  });

  const rows = table.getRowModel().rows;
  const columnCount = table.getVisibleLeafColumns().length;
  const cellPadding = density === 'compact' ? 'py-1.5' : 'py-3';

  const body = (() => {
    if (error !== undefined && error !== null && !loading) {
      return <ErrorState error={error} onRetry={onRetry} size="inline" />;
    }
    if (!loading && rows.length === 0) {
      return filtered ? (
        <EmptyState
          icon={SearchX}
          size="inline"
          title="Tidak ada yang cocok"
          description="Ubah kata kunci atau filter untuk melihat data lain."
          action={
            onResetFilters ? (
              <Button variant="outline" size="sm" onClick={onResetFilters}>
                Atur ulang filter
              </Button>
            ) : undefined
          }
        />
      ) : (
        <EmptyState icon={empty.icon} size="inline" title={empty.title} description={empty.description} action={empty.action} />
      );
    }
    return null;
  })();

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <div className={cn('overflow-hidden rounded-xl border bg-card shadow-card', mobileCard && 'max-md:hidden')}>
        <Table aria-label={label} aria-busy={loading || undefined}>
          <TableHeader className="sticky top-0 z-[1]">
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id} className="hover:bg-transparent">
                {headerGroup.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    colSpan={header.colSpan}
                    className={cn('first:pl-4 last:pr-4', header.column.columnDef.meta?.headerClassName)}
                    aria-sort={
                      header.column.getIsSorted() === 'asc'
                        ? 'ascending'
                        : header.column.getIsSorted() === 'desc'
                          ? 'descending'
                          : undefined
                    }
                  >
                    {header.isPlaceholder ? null : <FlexRender header={header} />}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {loading
              ? Array.from({ length: skeletonRows }, (_, i) => (
                  <TableRow key={`skeleton-${i}`} className="hover:bg-transparent">
                    {Array.from({ length: columnCount }, (__, j) => (
                      <TableCell key={j} className={cn('first:pl-4 last:pr-4', cellPadding)}>
                        <Skeleton className={cn('h-4', j === 0 ? 'w-40' : 'w-20')} />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              : body
                ? (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={columnCount} className="p-0 whitespace-normal">
                        {body}
                      </TableCell>
                    </TableRow>
                  )
                : rows.map((row) => (
                    <TableRow
                      key={row.id}
                      className={cn(onRowClick && 'cursor-pointer')}
                      onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                    >
                      {row.getVisibleCells().map((cell) => (
                        <TableCell
                          key={cell.id}
                          className={cn('first:pl-4 last:pr-4', cellPadding, cell.column.columnDef.meta?.cellClassName)}
                        >
                          <FlexRender cell={cell} />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
          </TableBody>
        </Table>
      </div>

      {mobileCard ? (
        <div className="flex flex-col gap-3 md:hidden" aria-label={label} role="list" aria-busy={loading || undefined}>
          {loading ? (
            Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-28 w-full rounded-xl" />)
          ) : body ? (
            <div className="rounded-xl border bg-card shadow-card">{body}</div>
          ) : (
            rows.map((row) => (
              <div key={row.id} role="listitem">
                {mobileCard(row.original)}
              </div>
            ))
          )}
        </div>
      ) : null}

      {footer}
    </div>
  );
}
