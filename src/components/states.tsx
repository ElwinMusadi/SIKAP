import type { ReactNode } from 'react';
import { RefreshCw, TriangleAlert, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';

type StateSize = 'page' | 'card' | 'inline';

const SIZE: Record<StateSize, { wrap: string; badge: string; icon: string; title: string }> = {
  page: { wrap: 'min-h-[50svh] py-16', badge: 'size-14', icon: 'size-6', title: 'text-h2' },
  card: { wrap: 'py-12', badge: 'size-12', icon: 'size-5', title: 'text-h3' },
  inline: { wrap: 'py-8', badge: 'size-10', icon: 'size-5', title: 'text-sm font-semibold' },
};

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  size?: StateSize;
  className?: string;
}

/** One empty state for pages, cards and table bodies (replaces dashed/solid/plain-text variants). */
export function EmptyState({ icon: Icon, title, description, action, size = 'card', className }: EmptyStateProps) {
  const s = SIZE[size];
  return (
    <div className={cn('flex flex-col items-center justify-center gap-3 px-6 text-center', s.wrap, className)}>
      <span className={cn('flex items-center justify-center rounded-full bg-muted text-muted-foreground ring-8 ring-muted/40', s.badge)}>
        <Icon className={s.icon} aria-hidden="true" />
      </span>
      <div className="flex max-w-sm flex-col gap-1">
        <p className={cn('text-foreground', s.title)}>{title}</p>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {action ? <div className="mt-1 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  );
}

interface ErrorStateProps {
  error?: unknown;
  title?: string;
  onRetry?: () => void;
  retrying?: boolean;
  size?: StateSize;
  className?: string;
}

/** One error state: icon, message from the API error, and always a retry when possible. */
export function ErrorState({ error, title = 'Data gagal dimuat', onRetry, retrying, size = 'card', className }: ErrorStateProps) {
  const s = SIZE[size];
  return (
    <div role="alert" className={cn('flex flex-col items-center justify-center gap-3 px-6 text-center', s.wrap, className)}>
      <span className={cn('flex items-center justify-center rounded-full bg-status-rejected-muted text-status-rejected', s.badge)}>
        <TriangleAlert className={s.icon} aria-hidden="true" />
      </span>
      <div className="flex max-w-sm flex-col gap-1">
        <p className={cn('text-foreground', s.title)}>{title}</p>
        {error !== undefined ? <p className="text-sm text-muted-foreground">{errorMessage(error)}</p> : null}
      </div>
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry} disabled={retrying}>
          {retrying ? <Spinner data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" />}
          Coba lagi
        </Button>
      ) : null}
    </div>
  );
}
