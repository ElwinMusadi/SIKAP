import type { LucideIcon } from 'lucide-react';
import { CircleCheck, CircleDashed, Clock, TriangleAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export type DocumentStatus = 'Belum diunggah' | 'Menunggu' | 'Terverifikasi' | 'Ditolak';

const STATUS_STYLES: Record<DocumentStatus, { icon: LucideIcon; className: string }> = {
  'Belum diunggah': {
    icon: CircleDashed,
    className: 'border-status-missing/30 bg-status-missing-muted text-status-missing',
  },
  Menunggu: {
    icon: Clock,
    className: 'border-status-pending/30 bg-status-pending-muted text-status-pending',
  },
  Terverifikasi: {
    icon: CircleCheck,
    className: 'border-status-verified/30 bg-status-verified-muted text-status-verified',
  },
  Ditolak: {
    icon: TriangleAlert,
    className: 'border-status-rejected/30 bg-status-rejected-muted text-status-rejected',
  },
};

export function StatusBadge({ status, className }: { status: DocumentStatus; className?: string }) {
  const { icon: Icon, className: tone } = STATUS_STYLES[status];
  return (
    <Badge variant="outline" className={cn(tone, className)}>
      <Icon data-icon="inline-start" aria-hidden="true" />
      {status}
    </Badge>
  );
}
