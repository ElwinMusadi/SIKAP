import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Link } from 'react-router';
import { cn } from '@/lib/utils';

interface PageHeaderProps {
  title: string;
  description?: ReactNode;
  /** Max. one primary + two secondary buttons; put the rest in a "…" menu. */
  actions?: ReactNode;
  /** Small uppercase label above the title (section or entity type). */
  eyebrow?: ReactNode;
  /** Back link for detail pages, e.g. { to: '/admin/pegawai', label: 'Master Data Pegawai' }. */
  back?: { to: string; label: string };
  /** Badges/meta row under the title (status chips, counts). */
  meta?: ReactNode;
  className?: string;
}

/** The one page header (template "Daftar", "Detail", "Formulir"; docs/RENCANA-REDESIGN-UIUX.md §6). */
export function PageHeader({ title, description, actions, eyebrow, back, meta, className }: PageHeaderProps) {
  return (
    <div className={cn('flex flex-col gap-3', className)}>
      {back ? (
        <Link
          to={back.to}
          className="inline-flex w-fit items-center gap-1.5 rounded-md text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          {back.label}
        </Link>
      ) : null}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          {eyebrow ? <p className="text-eyebrow text-muted-foreground uppercase">{eyebrow}</p> : null}
          <h1 className="font-heading text-2xl font-semibold tracking-tight text-foreground sm:text-display">{title}</h1>
          {description ? <p className="max-w-prose text-sm text-muted-foreground">{description}</p> : null}
          {meta ? <div className="mt-1 flex flex-wrap items-center gap-2">{meta}</div> : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}
