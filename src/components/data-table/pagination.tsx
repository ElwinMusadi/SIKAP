import { useId } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { pageCountFor, pageNumbers, rangeLabel } from './table-utils';

interface DataTablePaginationProps {
  /** 1-based current page. */
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  /** Omit to hide the page-size picker. */
  pageSizes?: readonly number[];
  onPageSizeChange?: (pageSize: number) => void;
  /** Rows are being refetched for the new page (keeps the old rows visible). */
  busy?: boolean;
  className?: string;
}

/** The one pagination model: range label, page size, numbered pages (prev/next + "x/y" on phones). */
export function DataTablePagination({
  page,
  pageSize,
  total,
  onPageChange,
  pageSizes,
  onPageSizeChange,
  busy,
  className,
}: DataTablePaginationProps) {
  const pageCount = pageCountFor(total, pageSize);
  const sizeId = useId();
  const go = (p: number) => onPageChange(Math.min(pageCount, Math.max(1, p)));

  return (
    <nav
      aria-label="Navigasi halaman"
      className={cn('flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-1', busy && 'opacity-70', className)}
    >
      <p className="text-sm text-muted-foreground tabular-nums" aria-live="polite">
        {rangeLabel(page, pageSize, total)}
      </p>
      <div className="flex items-center gap-4">
        {pageSizes && onPageSizeChange ? (
          <div className="hidden items-center gap-2 sm:flex">
            <label htmlFor={sizeId} className="text-sm text-muted-foreground">
              Per halaman
            </label>
            <Select value={String(pageSize)} onValueChange={(value) => onPageSizeChange(Number(value))}>
              <SelectTrigger id={sizeId} size="sm" className="w-20">
                <SelectValue />
              </SelectTrigger>
              <SelectContent side="top">
                {pageSizes.map((size) => (
                  <SelectItem key={size} value={String(size)}>
                    {size}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon-sm" onClick={() => go(page - 1)} disabled={page <= 1} aria-label="Halaman sebelumnya">
            <ChevronLeft />
          </Button>
          <ul className="hidden items-center gap-1 sm:flex">
            {pageNumbers(page, pageCount).map((p, i) =>
              p === 'gap' ? (
                <li key={`gap-${i}`} aria-hidden="true" className="px-1 text-sm text-muted-foreground">
                  …
                </li>
              ) : (
                <li key={p}>
                  <Button
                    variant={p === page ? 'secondary' : 'ghost'}
                    size="icon-sm"
                    className={cn('tabular-nums', p === page && 'bg-accent-soft font-semibold text-primary hover:bg-accent-soft')}
                    aria-current={p === page ? 'page' : undefined}
                    aria-label={`Halaman ${p}`}
                    onClick={() => go(p)}
                  >
                    {p}
                  </Button>
                </li>
              ),
            )}
          </ul>
          <span className="px-2 text-sm text-muted-foreground tabular-nums sm:hidden">
            {page}/{pageCount}
          </span>
          <Button
            variant="outline"
            size="icon-sm"
            onClick={() => go(page + 1)}
            disabled={page >= pageCount}
            aria-label="Halaman berikutnya"
          >
            <ChevronRight />
          </Button>
        </div>
      </div>
    </nav>
  );
}
