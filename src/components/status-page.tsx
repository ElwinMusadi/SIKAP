import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

interface StatusPageProps {
  /** Small error code under the illustration, e.g. "404". */
  code: string;
  icon: LucideIcon;
  title: string;
  description: ReactNode;
  actions?: ReactNode;
  /** Outside the app shell (404, route errors): fill the viewport on the paper background. */
  fullScreen?: boolean;
}

/** Full-page state for 404 / 403 / route errors: thin line illustration, code, title, way back. */
export function StatusPage({ code, icon: Icon, title, description, actions, fullScreen }: StatusPageProps) {
  // Outside the shell there is no <main>: the page itself is the main landmark.
  const Root = fullScreen ? 'main' : 'div';
  return (
    <Root className={cn('flex items-center justify-center px-6 py-16', fullScreen ? 'min-h-svh bg-background' : 'min-h-[60svh]')}>
      <div className="flex max-w-md flex-col items-center gap-5 text-center">
        <div className="relative flex size-40 items-center justify-center text-muted-foreground" aria-hidden="true">
          <svg viewBox="0 0 160 160" className="absolute inset-0 size-full" fill="none" stroke="currentColor">
            <circle cx="80" cy="80" r="76" strokeWidth="1" strokeDasharray="3 6" opacity="0.45" />
            <circle cx="80" cy="80" r="58" strokeWidth="1" opacity="0.3" />
            <path d="M20 112 Q80 92 140 112" strokeWidth="1" opacity="0.35" />
            <circle cx="132" cy="44" r="3" strokeWidth="1" opacity="0.5" />
            <circle cx="28" cy="58" r="2" strokeWidth="1" opacity="0.5" />
          </svg>
          <span className="flex size-16 items-center justify-center rounded-2xl border bg-card text-foreground shadow-card">
            <Icon className="size-7" strokeWidth={1.5} />
          </span>
        </div>
        <p className="text-eyebrow text-muted-foreground uppercase tabular-nums">Kode {code}</p>
        <div className="flex flex-col gap-2">
          <h1 className="text-display text-foreground">{title}</h1>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        {actions ? <div className="flex flex-wrap justify-center gap-2">{actions}</div> : null}
      </div>
    </Root>
  );
}
