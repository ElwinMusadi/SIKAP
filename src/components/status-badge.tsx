import { Badge } from '@/components/ui/badge';
import {
  statusSpec,
  TONE_CLASSES,
  type DokumenStatus,
  type StatusDomain,
  type StatusValue,
} from '@/lib/status';
import { cn } from '@/lib/utils';

/** @deprecated alias kept for existing imports; use `DokumenStatus` from '@/lib/status'. */
export type DocumentStatus = DokumenStatus;

type StatusBadgeProps<D extends StatusDomain> = {
  status: StatusValue<D>;
  /** Defaults to document status for backwards compatibility. */
  domain?: D;
  /** Show only the icon + an accessible label (dense table cells). */
  iconOnly?: boolean;
  className?: string;
};

/** The one status pill: icon + label + tone from the registry (src/lib/status.ts). */
export function StatusBadge<D extends StatusDomain = 'dokumen'>({ status, domain, iconOnly, className }: StatusBadgeProps<D>) {
  const spec = statusSpec((domain ?? 'dokumen') as D, status);
  const Icon = spec.icon;
  return (
    <Badge
      variant="outline"
      className={cn(TONE_CLASSES[spec.tone].badge, iconOnly && 'size-6 justify-center rounded-full p-0', className)}
      title={iconOnly ? spec.label : undefined}
    >
      <Icon data-icon="inline-start" aria-hidden="true" className={iconOnly ? 'm-0' : undefined} />
      {iconOnly ? <span className="sr-only">{spec.label}</span> : spec.label}
    </Badge>
  );
}

/** Small coloured dot + label, for inline text and legends. */
export function StatusDot<D extends StatusDomain>({ domain, status, className }: { domain: D; status: StatusValue<D>; className?: string }) {
  const spec = statusSpec(domain, status);
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-sm', className)}>
      <span aria-hidden="true" className={cn('size-2 rounded-full', TONE_CLASSES[spec.tone].solid)} />
      {spec.label}
    </span>
  );
}
