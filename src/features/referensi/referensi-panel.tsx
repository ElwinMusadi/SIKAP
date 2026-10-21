import { useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { GraduationCap, Info, ListTree, Network, Pencil, Plus, Save, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import {
  createPangkatSchema,
  createUnitSchema,
  updatePangkatSchema,
  updateUnitSchema,
  type AdminPangkat,
  type AdminUnit,
  type UpdatePangkatRequest,
  type UpdateUnitRequest,
} from '@shared/administrasi';
import { DataTable, SortableHeader, columnHelper, type DataTableColumn } from '@/components/data-table/data-table';
import { ErrorState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { errorMessage, isApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useAdminRef, useCreatePangkat, useCreateUnit, useUpdatePangkat, useUpdateUnit } from './queries';

type Errors = Record<string, string | undefined>;
type Pendidikan = { kode: string; nama: string; urutan: number };

function issuesToErrors(issues: readonly { path: readonly PropertyKey[]; message: string }[]): Errors {
  const errors: Errors = {};
  for (const issue of issues) errors[String(issue.path[0] ?? 'form')] ??= issue.message;
  return errors;
}

const pangkatCol = columnHelper<AdminPangkat>();
const unitCol = columnHelper<AdminUnit>();
const pendidikanCol = columnHelper<Pendidikan>();

function aktifCell(aktif: boolean) {
  return <StatusBadge domain="aktif" status={aktif ? 'Aktif' : 'Nonaktif'} />;
}

function EditButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button variant="ghost" size="sm" onClick={onClick}>
      <Pencil data-icon="inline-start" />
      Ubah<span className="sr-only"> {label}</span>
    </Button>
  );
}

export function ReferensiPanel() {
  const query = useAdminRef();
  const [pangkatDialog, setPangkatDialog] = useState<{ item: AdminPangkat | null } | null>(null);
  const [unitDialog, setUnitDialog] = useState<{ item: AdminUnit | null } | null>(null);
  // Owned here (not inside the forms) so each dialog can refuse to close while its save is pending.
  const pangkatMutations: PangkatMutations = { create: useCreatePangkat(), update: useUpdatePangkat() };
  const unitMutations: UnitMutations = { create: useCreateUnit(), update: useUpdateUnit() };
  const pangkatBusy = pangkatMutations.create.isPending || pangkatMutations.update.isPending;
  const unitBusy = unitMutations.create.isPending || unitMutations.update.isPending;

  const pangkatColumns = useMemo<DataTableColumn<AdminPangkat>[]>(
    () => [
      pangkatCol.accessor('urutan', {
        header: ({ column }) => <SortableHeader column={column} title="Urutan" />,
        sortFn: 'basic',
        meta: { headerClassName: 'w-24', cellClassName: 'text-muted-foreground tabular-nums' },
      }),
      pangkatCol.accessor('kode', { header: 'Kode', meta: { headerClassName: 'w-24', cellClassName: 'font-mono' } }),
      pangkatCol.accessor('nama', {
        header: ({ column }) => <SortableHeader column={column} title="Nama" />,
        sortFn: 'text',
        meta: { cellClassName: 'max-w-64 truncate' },
      }),
      pangkatCol.accessor('jenisAsn', { header: 'ASN', meta: { headerClassName: 'w-20' }, cell: (info) => <Badge variant="outline">{info.getValue()}</Badge> }),
      pangkatCol.accessor('aktif', { header: 'Status', meta: { headerClassName: 'w-28' }, cell: (info) => aktifCell(info.getValue()) }),
      pangkatCol.display({
        id: 'aksi',
        header: () => <span className="sr-only">Aksi</span>,
        meta: { headerClassName: 'w-24', cellClassName: 'text-right' },
        cell: ({ row }) => <EditButton label={`pangkat ${row.original.kode}`} onClick={() => setPangkatDialog({ item: row.original })} />,
      }),
    ],
    [],
  );

  const unitColumns = useMemo<DataTableColumn<AdminUnit>[]>(
    () => [
      unitCol.accessor('id', {
        header: ({ column }) => <SortableHeader column={column} title="ID" />,
        sortFn: 'basic',
        meta: { headerClassName: 'w-20', cellClassName: 'text-muted-foreground tabular-nums' },
      }),
      unitCol.accessor('nama', {
        header: ({ column }) => <SortableHeader column={column} title="Nama" />,
        sortFn: 'text',
        meta: { cellClassName: 'max-w-96 truncate' },
      }),
      unitCol.accessor('aktif', { header: 'Status', meta: { headerClassName: 'w-28' }, cell: (info) => aktifCell(info.getValue()) }),
      unitCol.display({
        id: 'aksi',
        header: () => <span className="sr-only">Aksi</span>,
        meta: { headerClassName: 'w-24', cellClassName: 'text-right' },
        cell: ({ row }) => <EditButton label={`unit ${row.original.nama}`} onClick={() => setUnitDialog({ item: row.original })} />,
      }),
    ],
    [],
  );

  const pendidikanColumns = useMemo<DataTableColumn<Pendidikan>[]>(
    () => [
      pendidikanCol.accessor('urutan', { header: 'Urutan', meta: { headerClassName: 'w-24', cellClassName: 'text-muted-foreground tabular-nums' } }),
      pendidikanCol.accessor('kode', { header: 'Kode', meta: { headerClassName: 'w-24', cellClassName: 'font-mono' } }),
      pendidikanCol.accessor('nama', { header: 'Nama' }),
    ],
    [],
  );

  if (query.isPending) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Memuat data referensi">
        <Skeleton className="h-64 w-full rounded-xl" />
        <Skeleton className="h-48 w-full rounded-xl" />
      </div>
    );
  }
  if (query.isError) {
    return (
      <Card className="py-0">
        <ErrorState error={query.error} title="Gagal memuat data referensi" onRetry={() => void query.refetch()} retrying={query.isFetching} />
      </Card>
    );
  }

  const { pangkat, unit, pendidikan } = query.data;
  const nextUrutan = pangkat.reduce((max, p) => Math.max(max, p.urutan), 0) + 1;
  return (
    <div className="flex flex-col gap-8" aria-busy={query.isFetching || undefined}>
      <Alert className="max-w-3xl">
        <Info aria-hidden="true" />
        <AlertTitle>Data referensi tidak dapat dihapus</AlertTitle>
        <AlertDescription>
          Nonaktifkan pangkat atau unit yang tidak dipakai lagi; nilai yang sudah tercatat pada data pegawai tetap berlaku sebagai data historis,
          tetapi tidak muncul untuk input baru.
        </AlertDescription>
      </Alert>

      <RefSection
        title="Pangkat / golongan"
        description="Kode dan jenis ASN tidak dapat diubah setelah dibuat."
        action={
          <Button size="sm" onClick={() => setPangkatDialog({ item: null })}>
            <Plus data-icon="inline-start" />
            Tambah pangkat
          </Button>
        }
      >
        <DataTable
          label="Pangkat / golongan"
          data={pangkat}
          columns={pangkatColumns}
          getRowId={(row) => row.kode}
          density="compact"
          empty={{ icon: ListTree, title: 'Belum ada pangkat' }}
          mobileCard={(p) => (
            <RefMobileCard
              title={p.nama}
              meta={`${p.kode} · ${p.jenisAsn} · urutan ${p.urutan}`}
              aktif={p.aktif}
              onEdit={() => setPangkatDialog({ item: p })}
              editLabel={`pangkat ${p.kode}`}
            />
          )}
        />
      </RefSection>

      <RefSection
        title="Unit kerja"
        description="ID unit dibuat otomatis oleh sistem."
        action={
          <Button size="sm" onClick={() => setUnitDialog({ item: null })}>
            <Plus data-icon="inline-start" />
            Tambah unit
          </Button>
        }
      >
        <DataTable
          label="Unit kerja"
          data={unit}
          columns={unitColumns}
          getRowId={(row) => String(row.id)}
          density="compact"
          empty={{ icon: Network, title: 'Belum ada unit kerja' }}
          mobileCard={(u) => (
            <RefMobileCard title={u.nama} meta={`ID ${u.id}`} aktif={u.aktif} onEdit={() => setUnitDialog({ item: u })} editLabel={`unit ${u.nama}`} />
          )}
        />
      </RefSection>

      <RefSection title="Pendidikan" description="Hanya baca. Daftar jenjang pendidikan dikelola oleh sistem.">
        <DataTable
          label="Pendidikan"
          data={pendidikan}
          columns={pendidikanColumns}
          getRowId={(row) => row.kode}
          density="compact"
          empty={{ icon: GraduationCap, title: 'Belum ada data pendidikan' }}
        />
      </RefSection>

      <RefDialog open={pangkatDialog !== null} busy={pangkatBusy} onClose={() => setPangkatDialog(null)}>
        {pangkatDialog ? (
          <PangkatForm
            key={pangkatDialog.item?.kode ?? 'new'}
            item={pangkatDialog.item}
            nextUrutan={nextUrutan}
            mutations={pangkatMutations}
            onDone={() => setPangkatDialog(null)}
          />
        ) : null}
      </RefDialog>
      <RefDialog open={unitDialog !== null} busy={unitBusy} onClose={() => setUnitDialog(null)}>
        {unitDialog ? (
          <UnitForm key={unitDialog.item?.id ?? 'new'} item={unitDialog.item} mutations={unitMutations} onDone={() => setUnitDialog(null)} />
        ) : null}
      </RefDialog>
    </div>
  );
}

function RefSection({ title, description, action, children }: { title: string; description: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h3 className="text-h3 text-foreground">{title}</h3>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function RefMobileCard({ title, meta, aktif, onEdit, editLabel }: { title: string; meta: string; aktif: boolean; onEdit: () => void; editLabel: string }) {
  return (
    <div className={cn('flex items-center gap-3 rounded-xl border bg-card p-4 shadow-card', !aktif && 'bg-muted/40')}>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate font-medium">{title}</span>
        <span className="text-xs text-muted-foreground tabular-nums">{meta}</span>
        <span className="w-fit">{aktifCell(aktif)}</span>
      </div>
      <EditButton label={editLabel} onClick={onEdit} />
    </div>
  );
}

type PangkatMutations = { create: ReturnType<typeof useCreatePangkat>; update: ReturnType<typeof useUpdatePangkat> };
type UnitMutations = { create: ReturnType<typeof useCreateUnit>; update: ReturnType<typeof useUpdateUnit> };

/** Escape, overlay click and the close button are ignored while `busy`. */
function RefDialog({ open, busy, onClose, children }: { open: boolean; busy: boolean; onClose: () => void; children: ReactNode }) {
  const block = (event: Event) => {
    if (busy) event.preventDefault();
  };
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
      <DialogContent className="sm:max-w-md" onEscapeKeyDown={block} onInteractOutside={block} aria-busy={busy || undefined}>
        {children}
      </DialogContent>
    </Dialog>
  );
}

function DeactivateWarning({ show, label }: { show: boolean; label: string }) {
  if (!show) return null;
  return (
    <Alert variant="pending" role="status">
      <TriangleAlert aria-hidden="true" />
      <AlertTitle>{label} akan dinonaktifkan</AlertTitle>
      <AlertDescription>
        Pegawai yang sudah memakai nilai ini tetap menyimpannya sebagai data historis yang sah. Nilai nonaktif tidak dapat dipilih untuk input atau
        perubahan data baru.
      </AlertDescription>
    </Alert>
  );
}

function AktifSwitch({ id, checked, onChange, disabled }: { id: string; checked: boolean; onChange: (v: boolean) => void; disabled: boolean }) {
  return (
    <Field orientation="horizontal" data-disabled={disabled || undefined}>
      <FieldContent>
        <FieldLabel htmlFor={id}>Aktif</FieldLabel>
        <FieldDescription id={`${id}-description`}>Hanya nilai aktif yang dapat dipilih pada formulir pegawai.</FieldDescription>
      </FieldContent>
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} aria-describedby={`${id}-description`} />
    </Field>
  );
}

function FormAlert({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <Alert variant="destructive" role="alert">
      <TriangleAlert aria-hidden="true" />
      <AlertTitle>Gagal menyimpan</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

function handleSaveError(error: unknown, setErrors: (e: Errors) => void, setFormError: (m: string) => void) {
  if (isApiError(error) && error.fields) setErrors(error.fields);
  setFormError(errorMessage(error));
}

function PangkatForm({ item, nextUrutan, mutations, onDone }: { item: AdminPangkat | null; nextUrutan: number; mutations: PangkatMutations; onDone: () => void }) {
  const id = useId();
  const { create, update } = mutations;
  const busy = create.isPending || update.isPending;
  const busyRef = useRef(false);
  const [kode, setKode] = useState(item?.kode ?? '');
  const [nama, setNama] = useState(item?.nama ?? '');
  const [jenisAsn, setJenisAsn] = useState<'PNS' | 'PPPK'>(item?.jenisAsn ?? 'PNS');
  const [urutan, setUrutan] = useState(String(item?.urutan ?? nextUrutan));
  const [aktif, setAktif] = useState(item?.aktif ?? true);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);

  const touch = (key: string) => {
    setErrors((e) => ({ ...e, [key]: undefined }));
    setFormError(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busyRef.current) return;
    const urutanNum = urutan.trim() === '' ? Number.NaN : Number(urutan);
    if (!Number.isInteger(urutanNum)) {
      setErrors({ urutan: 'Urutan harus berupa bilangan bulat.' });
      return;
    }
    busyRef.current = true;
    try {
      if (item) {
        const body: UpdatePangkatRequest = {};
        if (nama.trim() !== item.nama) body.nama = nama.trim();
        if (urutanNum !== item.urutan) body.urutan = urutanNum;
        if (aktif !== item.aktif) body.aktif = aktif;
        if (Object.keys(body).length === 0) {
          setFormError('Tidak ada perubahan.');
          return;
        }
        const parsed = updatePangkatSchema.safeParse(body);
        if (!parsed.success) {
          const e = issuesToErrors(parsed.error.issues);
          setErrors(e);
          if (e.form) setFormError(e.form);
          return;
        }
        // Send exactly the validated diff: only fields the admin changed.
        await update.mutateAsync({ kode: item.kode, body });
        toast.success(`Pangkat ${item.kode} diperbarui.`);
      } else {
        const parsed = createPangkatSchema.safeParse({ kode: kode.trim(), nama: nama.trim(), jenisAsn, urutan: urutanNum, aktif });
        if (!parsed.success) {
          setErrors(issuesToErrors(parsed.error.issues));
          return;
        }
        await create.mutateAsync(parsed.data);
        toast.success(`Pangkat ${parsed.data.kode} ditambahkan.`);
      }
      onDone();
    } catch (error) {
      handleSaveError(error, setErrors, setFormError);
    } finally {
      busyRef.current = false;
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>{item ? `Ubah pangkat ${item.kode}` : 'Tambah pangkat'}</DialogTitle>
        <DialogDescription>{item ? 'Kode dan jenis ASN tidak dapat diubah.' : 'Kode dan jenis ASN tidak dapat diubah setelah disimpan.'}</DialogDescription>
      </DialogHeader>
      <FieldGroup>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field data-invalid={errors.kode ? true : undefined}>
            <FieldLabel htmlFor={`${id}-kode`}>Kode</FieldLabel>
            <Input
              id={`${id}-kode`}
              value={kode}
              onChange={(e) => { setKode(e.target.value); touch('kode'); }}
              readOnly={!!item}
              disabled={busy}
              className="font-mono"
              placeholder="III/a"
              maxLength={20}
              aria-invalid={errors.kode ? true : undefined}
              aria-describedby={errors.kode ? `${id}-kode-error` : undefined}
            />
            {errors.kode ? <FieldError id={`${id}-kode-error`}>{errors.kode}</FieldError> : null}
          </Field>
          <Field data-invalid={errors.jenisAsn ? true : undefined}>
            <FieldLabel htmlFor={`${id}-asn`}>Jenis ASN</FieldLabel>
            <Select value={jenisAsn} onValueChange={(v) => { if (v === 'PNS' || v === 'PPPK') setJenisAsn(v); }} disabled={busy || !!item}>
              <SelectTrigger id={`${id}-asn`} className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="PNS">PNS</SelectItem>
                <SelectItem value="PPPK">PPPK</SelectItem>
              </SelectContent>
            </Select>
            {errors.jenisAsn ? <FieldError>{errors.jenisAsn}</FieldError> : null}
          </Field>
        </div>
        <Field data-invalid={errors.nama ? true : undefined}>
          <FieldLabel htmlFor={`${id}-nama`}>Nama pangkat</FieldLabel>
          <Input
            id={`${id}-nama`}
            value={nama}
            onChange={(e) => { setNama(e.target.value); touch('nama'); }}
            disabled={busy}
            placeholder="Penata Muda"
            maxLength={150}
            aria-invalid={errors.nama ? true : undefined}
            aria-describedby={errors.nama ? `${id}-nama-error` : undefined}
          />
          {errors.nama ? <FieldError id={`${id}-nama-error`}>{errors.nama}</FieldError> : null}
        </Field>
        <Field data-invalid={errors.urutan ? true : undefined}>
          <FieldLabel htmlFor={`${id}-urutan`}>Urutan</FieldLabel>
          <Input
            id={`${id}-urutan`}
            type="number"
            inputMode="numeric"
            min={0}
            max={10000}
            step={1}
            value={urutan}
            onChange={(e) => { setUrutan(e.target.value); touch('urutan'); }}
            disabled={busy}
            className="sm:max-w-32"
            aria-invalid={errors.urutan ? true : undefined}
            aria-describedby={errors.urutan ? `${id}-urutan-error` : undefined}
          />
          {errors.urutan ? <FieldError id={`${id}-urutan-error`}>{errors.urutan}</FieldError> : null}
        </Field>
        <AktifSwitch id={`${id}-aktif`} checked={aktif} onChange={(v) => { setAktif(v); touch('aktif'); }} disabled={busy} />
        <DeactivateWarning show={!!item?.aktif && !aktif} label={`Pangkat ${item?.kode ?? ''}`} />
        <FormAlert message={formError} />
      </FieldGroup>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone} disabled={busy}>Batal</Button>
        <Button type="submit" disabled={busy}>
          {busy ? <Spinner data-icon="inline-start" /> : <Save data-icon="inline-start" />}
          {item ? 'Simpan perubahan' : 'Tambah pangkat'}
        </Button>
      </DialogFooter>
    </form>
  );
}

function UnitForm({ item, mutations, onDone }: { item: AdminUnit | null; mutations: UnitMutations; onDone: () => void }) {
  const id = useId();
  const { create, update } = mutations;
  const busy = create.isPending || update.isPending;
  const busyRef = useRef(false);
  const [nama, setNama] = useState(item?.nama ?? '');
  const [aktif, setAktif] = useState(item?.aktif ?? true);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      if (item) {
        const body: UpdateUnitRequest = {};
        if (nama.trim() !== item.nama) body.nama = nama.trim();
        if (aktif !== item.aktif) body.aktif = aktif;
        if (Object.keys(body).length === 0) {
          setFormError('Tidak ada perubahan.');
          return;
        }
        const parsed = updateUnitSchema.safeParse(body);
        if (!parsed.success) {
          const e = issuesToErrors(parsed.error.issues);
          setErrors(e);
          if (e.form) setFormError(e.form);
          return;
        }
        await update.mutateAsync({ id: item.id, body });
        toast.success('Unit kerja diperbarui.');
      } else {
        const parsed = createUnitSchema.safeParse({ nama: nama.trim(), aktif });
        if (!parsed.success) {
          setErrors(issuesToErrors(parsed.error.issues));
          return;
        }
        await create.mutateAsync(parsed.data);
        toast.success('Unit kerja ditambahkan.');
      }
      onDone();
    } catch (error) {
      handleSaveError(error, setErrors, setFormError);
    } finally {
      busyRef.current = false;
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>{item ? 'Ubah unit kerja' : 'Tambah unit kerja'}</DialogTitle>
        <DialogDescription>{item ? `ID unit ${item.id}.` : 'ID unit dibuat otomatis setelah disimpan.'}</DialogDescription>
      </DialogHeader>
      <FieldGroup>
        <Field data-invalid={errors.nama ? true : undefined}>
          <FieldLabel htmlFor={`${id}-nama`}>Nama unit</FieldLabel>
          <Input
            id={`${id}-nama`}
            value={nama}
            onChange={(e) => { setNama(e.target.value); setErrors({}); setFormError(null); }}
            disabled={busy}
            maxLength={150}
            aria-invalid={errors.nama ? true : undefined}
            aria-describedby={errors.nama ? `${id}-nama-error` : undefined}
          />
          {errors.nama ? <FieldError id={`${id}-nama-error`}>{errors.nama}</FieldError> : null}
        </Field>
        <AktifSwitch id={`${id}-aktif`} checked={aktif} onChange={(v) => { setAktif(v); setFormError(null); }} disabled={busy} />
        <DeactivateWarning show={!!item?.aktif && !aktif} label="Unit kerja" />
        <FormAlert message={formError} />
      </FieldGroup>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone} disabled={busy}>Batal</Button>
        <Button type="submit" disabled={busy}>
          {busy ? <Spinner data-icon="inline-start" /> : <Save data-icon="inline-start" />}
          {item ? 'Simpan perubahan' : 'Tambah unit'}
        </Button>
      </DialogFooter>
    </form>
  );
}
