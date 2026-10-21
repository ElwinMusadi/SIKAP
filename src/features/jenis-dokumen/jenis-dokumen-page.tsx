import { useState } from 'react';
import { FilePlus2, FileStack, Pencil, RefreshCw, TriangleAlert } from 'lucide-react';
import { STATUS_KEPEGAWAIAN } from '@shared/enums';
import type { AdminJenisDokumen } from '@shared/administrasi';
import { PageHeader } from '@/components/page-header';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { JenisDialog, type JenisDialogState } from './jenis-dialog';
import { formatMaxSize } from './jenis-utils';
import { useAdminJenis } from './queries';

export default function JenisDokumenPage() {
  const query = useAdminJenis();
  const [dialog, setDialog] = useState<JenisDialogState>(null);
  const items = query.data?.items ?? [];
  const latest = dialog?.mode === 'edit' ? items.find((i) => i.id === dialog.item.id) : undefined;
  const nextUrutan = items.reduce((max, i) => Math.max(max, i.urutan), 0) + 10;
  const kategoriOptions = [...new Set(items.map((i) => i.kategori))].sort((a, b) => a.localeCompare(b, 'id'));
  const aktif = items.filter((i) => i.aktif).length;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Jenis Dokumen"
        description={
          query.data ? (
            <span className="tabular-nums">
              {items.length} jenis · {aktif} aktif · {items.length - aktif} nonaktif
            </span>
          ) : (
            'Atur jenis dokumen, batas ukuran, dan kewajiban per status kepegawaian.'
          )
        }
        actions={
          <Button onClick={() => setDialog({ mode: 'create' })}>
            <FilePlus2 data-icon="inline-start" />
            Tambah Jenis
          </Button>
        }
      />

      <p className="max-w-3xl text-sm text-muted-foreground">
        Perubahan status wajib berlaku surut untuk seluruh pegawai dan langsung memengaruhi persentase kelengkapan. Jenis dokumen tidak dapat
        dihapus; nonaktifkan jika tidak lagi dipakai, arsip yang ada tetap tersimpan.
      </p>

      {query.isPending ? (
        <JenisSkeleton />
      ) : query.isError ? (
        <Alert variant="destructive" role="alert">
          <TriangleAlert />
          <AlertTitle>Gagal memuat jenis dokumen</AlertTitle>
          <AlertDescription>
            <p>{errorMessage(query.error)}</p>
            <Button size="sm" variant="outline" className="mt-2" onClick={() => void query.refetch()} disabled={query.isFetching}>
              {query.isFetching ? <Spinner data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" />}
              Coba lagi
            </Button>
          </AlertDescription>
        </Alert>
      ) : items.length === 0 ? (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FileStack />
            </EmptyMedia>
            <EmptyTitle>Belum ada jenis dokumen</EmptyTitle>
            <EmptyDescription>Tambahkan jenis dokumen agar pegawai dapat mulai mengunggah arsip.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={() => setDialog({ mode: 'create' })}>
              <FilePlus2 data-icon="inline-start" />
              Tambah Jenis
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <section aria-label="Daftar jenis dokumen" aria-busy={query.isFetching || undefined}>
          <JenisTable items={items} onEdit={(item) => setDialog({ mode: 'edit', item })} />
          <JenisCards items={items} onEdit={(item) => setDialog({ mode: 'edit', item })} />
        </section>
      )}

      <JenisDialog
        state={dialog}
        onClose={() => setDialog(null)}
        latest={latest}
        nextUrutan={nextUrutan}
        onRefetch={async () => {
          const editId = dialog?.mode === 'edit' ? dialog.item.id : null;
          // throwOnError: a failed refetch must surface in the dialog instead of resolving with old data.
          const result = await query.refetch({ throwOnError: true });
          return result.data?.items.find((i) => i.id === editId);
        }}
        kategoriOptions={kategoriOptions}
      />
    </div>
  );
}

function WajibBadges({ item }: { item: AdminJenisDokumen }) {
  return (
    <ul className="flex flex-wrap gap-1" aria-label="Wajib untuk">
      {STATUS_KEPEGAWAIAN.map((status) => {
        const wajib = item.wajibUntuk.includes(status);
        return (
          <li key={status}>
            <Badge variant={wajib ? 'secondary' : 'outline'} className={cn(!wajib && 'text-muted-foreground line-through decoration-muted-foreground/50')}>
              {status}
              <span className="sr-only">{wajib ? ' wajib' : ' tidak wajib'}</span>
            </Badge>
          </li>
        );
      })}
    </ul>
  );
}

function AktifBadge({ aktif }: { aktif: boolean }) {
  return aktif ? (
    <Badge variant="outline" className="border-status-verified/30 bg-status-verified-muted text-status-verified">Aktif</Badge>
  ) : (
    <Badge variant="outline" className="text-muted-foreground">Nonaktif</Badge>
  );
}

function EditButton({ item, onEdit }: { item: AdminJenisDokumen; onEdit: (item: AdminJenisDokumen) => void }) {
  return (
    <Button variant="ghost" size="sm" onClick={() => onEdit(item)}>
      <Pencil data-icon="inline-start" />
      Ubah<span className="sr-only"> {item.nama}</span>
    </Button>
  );
}

function JenisTable({ items, onEdit }: { items: AdminJenisDokumen[]; onEdit: (item: AdminJenisDokumen) => void }) {
  return (
    <Card className="hidden py-0 md:flex">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-16 pl-4 text-right">Urutan</TableHead>
            <TableHead>Jenis dokumen</TableHead>
            <TableHead className="hidden lg:table-cell">Kategori</TableHead>
            <TableHead>Wajib untuk</TableHead>
            <TableHead className="text-right">Maks.</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="pr-4 text-right"><span className="sr-only">Aksi</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => (
            <TableRow key={item.id} className={cn(!item.aktif && 'bg-muted/30')}>
              <TableCell className="pl-4 text-right tabular-nums text-muted-foreground">{item.urutan}</TableCell>
              <TableCell className="max-w-72">
                <div className={cn('flex min-w-0 flex-col', !item.aktif && 'opacity-70')}>
                  <span className="truncate font-medium" title={item.nama}>{item.nama}</span>
                  <span className="truncate font-mono text-xs text-muted-foreground">{item.id}</span>
                  <span className="truncate text-xs text-muted-foreground lg:hidden">{item.kategori}</span>
                </div>
              </TableCell>
              <TableCell className="hidden max-w-48 truncate lg:table-cell">{item.kategori}</TableCell>
              <TableCell><WajibBadges item={item} /></TableCell>
              <TableCell className="text-right tabular-nums">{formatMaxSize(item.maxSizeBytes)}</TableCell>
              <TableCell><AktifBadge aktif={item.aktif} /></TableCell>
              <TableCell className="pr-4 text-right"><EditButton item={item} onEdit={onEdit} /></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

function JenisCards({ items, onEdit }: { items: AdminJenisDokumen[]; onEdit: (item: AdminJenisDokumen) => void }) {
  return (
    <ul className="flex flex-col gap-3 md:hidden">
      {items.map((item) => (
        <li key={item.id}>
          <Card size="sm" className={cn(!item.aktif && 'bg-muted/30')}>
            <CardContent className="flex flex-col gap-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col">
                  <span className="font-medium">{item.nama}</span>
                  <span className="truncate font-mono text-xs text-muted-foreground">{item.id}</span>
                  <span className="text-xs text-muted-foreground">
                    {item.kategori} · urutan {item.urutan} · maks. {formatMaxSize(item.maxSizeBytes)}
                  </span>
                </div>
                <AktifBadge aktif={item.aktif} />
              </div>
              <div className="flex items-center justify-between gap-2">
                <WajibBadges item={item} />
                <EditButton item={item} onEdit={onEdit} />
              </div>
            </CardContent>
          </Card>
        </li>
      ))}
    </ul>
  );
}

function JenisSkeleton() {
  return (
    <Card className="py-0" aria-busy="true" aria-label="Memuat jenis dokumen">
      <div className="flex flex-col divide-y">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="flex items-center gap-4 p-4">
            <Skeleton className="h-4 w-8" />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-3 w-28" />
            </div>
            <Skeleton className="hidden h-5 w-32 md:block" />
            <Skeleton className="h-5 w-14" />
          </div>
        ))}
      </div>
    </Card>
  );
}
