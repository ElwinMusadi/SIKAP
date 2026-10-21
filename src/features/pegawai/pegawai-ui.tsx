import { KeyRound, Lock } from 'lucide-react';
import type { Role, StatusAkun } from '@shared/enums';
import type { Kelengkapan, PegawaiListItem } from '@shared/pegawai';
import { StatusBadge } from '@/components/status-badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { initials } from '@/lib/format';
import { STATUS_REGISTRY, statusSpec, TONE_CLASSES } from '@/lib/status';
import { cn } from '@/lib/utils';

/** Kelengkapan badge/bar classes, derived from the single status registry. */
export const KELENGKAPAN_STYLE = Object.fromEntries(
  (Object.keys(STATUS_REGISTRY.kelengkapan) as Kelengkapan[]).map((k) => {
    const tone = TONE_CLASSES[statusSpec('kelengkapan', k).tone];
    return [k, { badge: tone.badge, bar: tone.bar }];
  }),
) as Record<Kelengkapan, { badge: string; bar: string }>;

export function PegawaiAvatar({ nama, fotoUrl, className }: { nama: string; fotoUrl: string | null; className?: string }) {
  return (
    <Avatar className={className}>
      {fotoUrl ? <AvatarImage src={fotoUrl} alt="" /> : null}
      <AvatarFallback className="text-xs font-medium">{initials(nama)}</AvatarFallback>
    </Avatar>
  );
}

export function StatusAkunBadge({ status }: { status: StatusAkun }) {
  return <StatusBadge domain="akun" status={status} />;
}

export function StatusKepegawaianBadge({ status }: { status: string | null }) {
  return status ? (
    <Badge variant="secondary">{status}</Badge>
  ) : (
    <Badge variant="outline" className="text-muted-foreground">
      Belum diisi
    </Badge>
  );
}

export function RoleBadge({ role }: { role: Role }) {
  return role === 'Admin' ? <Badge variant="outline">Admin</Badge> : null;
}

export function TerkunciIcon() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="inline-flex rounded-sm text-status-rejected outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
          <Lock aria-hidden="true" className="size-4" />
          <span className="sr-only">Akun terkunci</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>Terkunci sementara karena gagal login berulang</TooltipContent>
    </Tooltip>
  );
}

export function PasswordDefaultBadge() {
  return (
    <Badge variant="outline" className="text-muted-foreground">
      <KeyRound data-icon="inline-start" aria-hidden="true" />
      Password default
    </Badge>
  );
}

/** Status akun + lock + password default, in one line that wraps. */
export function AkunFlags({ item }: { item: Pick<PegawaiListItem, 'statusAkun' | 'terkunci' | 'isDefaultPassword'> }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <StatusAkunBadge status={item.statusAkun} />
      {item.terkunci ? <TerkunciIcon /> : null}
      {item.isDefaultPassword ? <PasswordDefaultBadge /> : null}
    </div>
  );
}

export function KelengkapanCell({ dokumen, className }: { dokumen: PegawaiListItem['dokumen']; className?: string }) {
  if (dokumen.wajibTotal === 0) {
    return <span className={cn('text-xs text-muted-foreground', className)}>Status kepegawaian belum diisi</span>;
  }
  const style = KELENGKAPAN_STYLE[dokumen.kelengkapan];
  return (
    <div className={cn('flex min-w-36 flex-col gap-1.5', className)}>
      <div className="flex items-center justify-between gap-2">
        <Badge variant="outline" className={style.badge}>
          {dokumen.kelengkapan}
        </Badge>
        <span className="text-xs text-muted-foreground tabular-nums">
          {dokumen.wajibTerverifikasi}/{dokumen.wajibTotal}
        </span>
      </div>
      <Progress
        value={dokumen.persen}
        className={cn('h-1.5', style.bar)}
        aria-label={`Dokumen wajib terverifikasi ${dokumen.wajibTerverifikasi} dari ${dokumen.wajibTotal}`}
      />
      {dokumen.menunggu > 0 ? (
        <span className="text-xs text-status-pending tabular-nums">{dokumen.menunggu} menunggu verifikasi</span>
      ) : null}
    </div>
  );
}
