import { progressPercent, progressSummary, progressTotal, type ProgressCounts } from '@/lib/progress';
import { TONE_CLASSES, type StatusTone } from '@/lib/status';
import { cn } from '@/lib/utils';

const SEGMENTS: { key: keyof ProgressCounts; label: string; tone: StatusTone }[] = [
  { key: 'terverifikasi', label: 'Terverifikasi', tone: 'verified' },
  { key: 'menunggu', label: 'Menunggu', tone: 'pending' },
  { key: 'ditolak', label: 'Ditolak', tone: 'rejected' },
  { key: 'belum', label: 'Belum diunggah', tone: 'neutral' },
];

interface ProgressMeterProps {
  counts: ProgressCounts;
  /** `full`: percent + segmented bar + legend. `compact`: thin bar + "n/m" (table cells, cards). */
  variant?: 'full' | 'compact';
  label?: string;
  className?: string;
}

export type { ProgressCounts };

/** The one completeness visual (replaces the ring, plain bar, big percent and chip variants). */
export function ProgressMeter({ counts, variant = 'full', label = 'Kelengkapan dokumen wajib', className }: ProgressMeterProps) {
  const total = progressTotal(counts);
  const percent = progressPercent(counts);
  const bar = (
    <div
      role="img"
      aria-label={`${label}: ${percent}%. ${progressSummary(counts)}.`}
      className={cn('flex w-full overflow-hidden rounded-full bg-muted', variant === 'full' ? 'h-2.5 gap-0.5' : 'h-1.5 gap-px')}
    >
      {total === 0
        ? null
        : SEGMENTS.map(({ key, tone }) =>
            counts[key] > 0 ? (
              <span
                key={key}
                className={cn('h-full first:rounded-l-full last:rounded-r-full', tone === 'neutral' ? 'bg-transparent' : TONE_CLASSES[tone].solid)}
                style={{ width: `${(counts[key] / total) * 100}%` }}
              />
            ) : null,
          )}
    </div>
  );

  if (variant === 'compact') {
    return (
      <div className={cn('flex min-w-28 items-center gap-2', className)}>
        {bar}
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {counts.terverifikasi}/{total}
        </span>
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm font-medium text-foreground">{label}</p>
        <p className="flex items-baseline gap-1">
          <span className="text-h2 tabular-nums">{percent}%</span>
          <span className="text-xs text-muted-foreground tabular-nums">
            {counts.terverifikasi}/{total}
          </span>
        </p>
      </div>
      {bar}
      <ul className="flex flex-wrap gap-x-4 gap-y-1.5" aria-hidden="true">
        {SEGMENTS.map(({ key, label: segLabel, tone }) => (
          <li key={key} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <span
              className={cn(
                'size-2 rounded-full',
                tone === 'neutral' ? 'border border-status-missing/60 bg-transparent' : TONE_CLASSES[tone].solid,
              )}
            />
            {segLabel}
            <span className="font-medium text-foreground tabular-nums">{counts[key]}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
