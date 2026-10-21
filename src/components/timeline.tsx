import type { ReactNode } from 'react';
import { Circle, type LucideIcon } from 'lucide-react';
import { TONE_CLASSES, type StatusTone } from '@/lib/status';
import { cn } from '@/lib/utils';

export interface TimelineItem {
  id: string | number;
  title: ReactNode;
  /** Time text, e.g. "5 menit lalu · 21 Okt 2026, 13.45 WITA". */
  meta?: ReactNode;
  description?: ReactNode;
  icon?: LucideIcon;
  tone?: StatusTone | 'primary';
}

/** Activity timeline (beranda, detail pegawai, log mode linimasa). */
export function Timeline({ items, className }: { items: TimelineItem[]; className?: string }) {
  return (
    <ol className={cn('flex flex-col', className)}>
      {items.map((item, index) => {
        const Icon = item.icon ?? Circle;
        const tone = item.tone && item.tone !== 'primary' ? TONE_CLASSES[item.tone].soft : 'bg-accent-soft text-primary';
        return (
          <li key={item.id} className="relative flex gap-3 pb-5 last:pb-0">
            {index < items.length - 1 ? (
              <span aria-hidden="true" className="absolute top-8 bottom-0 left-[0.9375rem] w-px bg-border" />
            ) : null}
            <span className={cn('relative flex size-8 shrink-0 items-center justify-center rounded-full ring-4 ring-card', tone)}>
              <Icon className={cn('size-4', !item.icon && 'size-2 fill-current')} aria-hidden="true" />
            </span>
            <div className="flex min-w-0 flex-col gap-0.5 pt-1">
              <p className="text-sm text-foreground">{item.title}</p>
              {item.description ? <p className="text-sm text-muted-foreground">{item.description}</p> : null}
              {item.meta ? <p className="text-xs text-muted-foreground tabular-nums">{item.meta}</p> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
