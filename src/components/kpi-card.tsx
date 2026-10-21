import type { ReactNode } from 'react';
import { ArrowRight, type LucideIcon } from 'lucide-react';
import { Link } from 'react-router';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

interface KpiCardProps {
  label: string;
  value: ReactNode;
  /** Small text after the number, e.g. "pegawai" or "%". */
  unit?: string;
  caption?: ReactNode;
  icon?: LucideIcon;
  /** Optional link shown as "label →" at the bottom. */
  link?: { to: string; label: string };
  /** `highlight` = amber work-queue card (e.g. "Menunggu verifikasi" with items). */
  tone?: 'default' | 'highlight';
  /** Extra content under the caption (chips, a ProgressMeter). */
  children?: ReactNode;
  loading?: boolean;
  className?: string;
}

/** The one KPI tile (replaces the two stat-tile styles and five "big number" sizes). */
export function KpiCard({ label, value, unit, caption, icon: Icon, link, tone = 'default', children, loading, className }: KpiCardProps) {
  const highlight = tone === 'highlight';
  return (
    <Card
      size="sm"
      className={cn(
        'relative gap-3 px-4 py-4',
        highlight && 'border-status-pending/30 bg-status-pending-muted/60 dark:bg-status-pending-muted',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-eyebrow text-muted-foreground uppercase">{label}</p>
        {Icon ? (
          <span
            className={cn(
              'flex size-8 shrink-0 items-center justify-center rounded-lg',
              highlight ? 'bg-card text-status-pending' : 'bg-accent-soft text-primary',
            )}
          >
            <Icon className="size-4" aria-hidden="true" />
          </span>
        ) : null}
      </div>
      {loading ? (
        <Skeleton className="h-8 w-20" />
      ) : (
        <p className="flex items-baseline gap-1.5">
          <span className="text-metric text-foreground tabular-nums">{value}</span>
          {unit ? <span className="text-sm text-muted-foreground">{unit}</span> : null}
        </p>
      )}
      {caption ? <p className="text-[13px] text-muted-foreground">{caption}</p> : null}
      {children}
      {link ? (
        <Link
          to={link.to}
          className="mt-auto inline-flex w-fit items-center gap-1 rounded-sm text-sm font-medium text-primary outline-none after:absolute after:inset-0 after:rounded-[inherit] hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          {link.label}
          <ArrowRight className="size-3.5" aria-hidden="true" />
        </Link>
      ) : null}
    </Card>
  );
}
