import { ArrowRight } from 'lucide-react';
import type { StatusPengajuan } from '@shared/enums';
import {
  KEPEGAWAIAN_FIELDS,
  KEPEGAWAIAN_LABELS,
  type KepegawaianField,
  type KepegawaianValue,
  type PerubahanMap,
  type RefResponse,
} from '@shared/profile';
import { StatusBadge } from '@/components/status-badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatKepegawaianValue } from '@/features/profil/format-values';

export function PengajuanStatusBadge({ status, className }: { status: StatusPengajuan; className?: string }) {
  return <StatusBadge domain="pengajuan" status={status} className={className} />;
}

export interface PerubahanEntry {
  field: KepegawaianField;
  lama: KepegawaianValue;
  baru: KepegawaianValue;
}

/** Changed fields in the canonical KEPEGAWAIAN_FIELDS order. */
export function perubahanEntries(map: PerubahanMap): PerubahanEntry[] {
  return KEPEGAWAIAN_FIELDS.flatMap((field) => {
    const change = map[field];
    return change ? [{ field, lama: change.lama, baru: change.baru }] : [];
  });
}

/** Compact "label: lama → baru" list (employee view). */
export function PerubahanList({ perubahan, refData }: { perubahan: PerubahanMap; refData: RefResponse | undefined }) {
  return (
    <ul className="flex flex-col gap-2">
      {perubahanEntries(perubahan).map(({ field, lama, baru }) => (
        <li key={field} className="grid gap-0.5 text-sm sm:grid-cols-[11rem_1fr] sm:gap-3">
          <span className="text-muted-foreground">{KEPEGAWAIAN_LABELS[field]}</span>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="text-muted-foreground line-through decoration-muted-foreground/50">
              {formatKepegawaianValue(field, lama, refData)}
            </span>
            <ArrowRight aria-label="menjadi" className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="font-medium text-foreground">{formatKepegawaianValue(field, baru, refData)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Side-by-side "lama → baru" per field (admin review sheet). Stacks on phones. */
export function PerubahanDiff({ perubahan, refData }: { perubahan: PerubahanMap; refData: RefResponse | undefined }) {
  return (
    <ul className="flex flex-col gap-3">
      {perubahanEntries(perubahan).map(({ field, lama, baru }) => (
        <li key={field} className="flex flex-col gap-1.5">
          <p className="text-eyebrow text-muted-foreground uppercase">{KEPEGAWAIAN_LABELS[field]}</p>
          <div className="grid items-stretch gap-2 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-center">
            <div className="rounded-lg border bg-muted/40 px-3 py-2 text-sm">
              <span className="sr-only">Data lama: </span>
              <span className="text-muted-foreground">{formatKepegawaianValue(field, lama, refData)}</span>
            </div>
            <ArrowRight aria-hidden="true" className="hidden size-4 text-muted-foreground sm:block" />
            <div className="rounded-lg border border-primary/25 bg-accent-soft px-3 py-2 text-sm">
              <span className="sr-only">Diajukan: </span>
              <span className="font-medium text-foreground">{formatKepegawaianValue(field, baru, refData)}</span>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Field | Data lama | Diajukan table (admin view). */
export function PerubahanTable({ perubahan, refData }: { perubahan: PerubahanMap; refData: RefResponse | undefined }) {
  return (
    <div className="overflow-hidden rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/50 hover:bg-muted/50">
            <TableHead className="w-[30%]">Data</TableHead>
            <TableHead className="w-[35%]">Data lama</TableHead>
            <TableHead>Diajukan</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {perubahanEntries(perubahan).map(({ field, lama, baru }) => (
            <TableRow key={field}>
              <TableCell className="font-medium whitespace-normal">{KEPEGAWAIAN_LABELS[field]}</TableCell>
              <TableCell className="whitespace-normal text-muted-foreground">
                {formatKepegawaianValue(field, lama, refData)}
              </TableCell>
              <TableCell className="font-medium whitespace-normal text-foreground">
                {formatKepegawaianValue(field, baru, refData)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
