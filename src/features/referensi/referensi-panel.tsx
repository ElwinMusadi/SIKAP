import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Info, Pencil, Plus, RefreshCw, Save, TriangleAlert } from 'lucide-react';
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
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { errorMessage, isApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useAdminRef, useCreatePangkat, useCreateUnit, useUpdatePangkat, useUpdateUnit } from './queries';

type Errors = Record<string, string | undefined>;

function issuesToErrors(issues: readonly { path: readonly PropertyKey[]; message: string }[]): Errors {
  const errors: Errors = {};
  for (const issue of issues) errors[String(issue.path[0] ?? 'form')] ??= issue.message;
  return errors;
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

  if (query.isPending) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Memuat data referensi">
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }
  if (query.isError) {
    return (
      <Alert variant="destructive" role="alert">
        <TriangleAlert />
        <AlertTitle>Gagal memuat data referensi</AlertTitle>
        <AlertDescription>
          <p>{errorMessage(query.error)}</p>
          <Button variant="outline" size="sm" className="mt-2" onClick={() => void query.refetch()} disabled={query.isFetching}>
            {query.isFetching ? <Spinner data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" />}Coba lagi
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const { pangkat, unit, pendidikan } = query.data;
  const nextUrutan = pangkat.reduce((max, p) => Math.max(max, p.urutan), 0) + 1;
  return (
    <div className="flex flex-col gap-6" aria-busy={query.isFetching || undefined}>
      <Alert>
        <Info />
        <AlertTitle>Data referensi tidak dapat dihapus</AlertTitle>
        <AlertDescription>
          Nonaktifkan pangkat atau unit yang tidak dipakai lagi. Nilai yang sudah tercatat pada data pegawai tetap berlaku sebagai data historis,
          tetapi pilihan nonaktif tidak muncul untuk input baru.
        </AlertDescription>
      </Alert>

      <RefCard
        title="Pangkat / golongan"
        description="Kode dan jenis ASN tidak dapat diubah setelah dibuat."
        action={<Button size="sm" onClick={() => setPangkatDialog({ item: null })}><Plus data-icon="inline-start" />Tambah pangkat</Button>}
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16 pl-4 text-right">Urutan</TableHead>
              <TableHead className="w-24">Kode</TableHead>
              <TableHead>Nama</TableHead>
              <TableHead className="w-20">ASN</TableHead>
              <TableHead className="w-24">Status</TableHead>
              <TableHead className="w-24 pr-4 text-right"><span className="sr-only">Aksi</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pangkat.length === 0 ? <EmptyRow colSpan={6} text="Belum ada pangkat." /> : pangkat.map((p) => (
              <TableRow key={p.kode} className={cn(!p.aktif && 'bg-muted/30 text-muted-foreground')}>
                <TableCell className="pl-4 text-right tabular-nums">{p.urutan}</TableCell>
                <TableCell className="font-mono">{p.kode}</TableCell>
                <TableCell className="max-w-64 truncate" title={p.nama}>{p.nama}</TableCell>
                <TableCell><Badge variant="outline">{p.jenisAsn}</Badge></TableCell>
                <TableCell><AktifBadge aktif={p.aktif} /></TableCell>
                <TableCell className="pr-4 text-right">
                  <Button variant="ghost" size="sm" onClick={() => setPangkatDialog({ item: p })}>
                    <Pencil data-icon="inline-start" />Ubah<span className="sr-only"> pangkat {p.kode}</span>
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </RefCard>

      <RefCard
        title="Unit kerja"
        description="ID unit dibuat otomatis oleh sistem."
        action={<Button size="sm" onClick={() => setUnitDialog({ item: null })}><Plus data-icon="inline-start" />Tambah unit</Button>}
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16 pl-4 text-right">ID</TableHead>
              <TableHead>Nama</TableHead>
              <TableHead className="w-24">Status</TableHead>
              <TableHead className="w-24 pr-4 text-right"><span className="sr-only">Aksi</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {unit.length === 0 ? <EmptyRow colSpan={4} text="Belum ada unit kerja." /> : unit.map((u) => (
              <TableRow key={u.id} className={cn(!u.aktif && 'bg-muted/30 text-muted-foreground')}>
                <TableCell className="pl-4 text-right tabular-nums">{u.id}</TableCell>
                <TableCell className="max-w-96 truncate" title={u.nama}>{u.nama}</TableCell>
                <TableCell><AktifBadge aktif={u.aktif} /></TableCell>
                <TableCell className="pr-4 text-right">
                  <Button variant="ghost" size="sm" onClick={() => setUnitDialog({ item: u })}>
                    <Pencil data-icon="inline-start" />Ubah<span className="sr-only"> unit {u.nama}</span>
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </RefCard>

      <RefCard title="Pendidikan" description="Hanya baca. Daftar jenjang pendidikan dikelola oleh sistem.">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16 pl-4 text-right">Urutan</TableHead>
              <TableHead className="w-24">Kode</TableHead>
              <TableHead className="pr-4">Nama</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pendidikan.length === 0 ? <EmptyRow colSpan={3} text="Belum ada data pendidikan." /> : pendidikan.map((p) => (
              <TableRow key={p.kode}>
                <TableCell className="pl-4 text-right tabular-nums">{p.urutan}</TableCell>
                <TableCell className="font-mono">{p.kode}</TableCell>
                <TableCell className="pr-4">{p.nama}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </RefCard>

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

function RefCard({ title, description, action, children }: { title: string; description: string; action?: ReactNode; children: ReactNode }) {
  return (
    <Card className="gap-0 pb-0">
      <CardHeader className="flex flex-row items-start justify-between gap-3 pb-4">
        <div className="flex flex-col gap-1">
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </div>
        {action}
      </CardHeader>
      <CardContent className="overflow-x-auto border-t px-0">{children}</CardContent>
    </Card>
  );
}

function EmptyRow({ colSpan, text }: { colSpan: number; text: string }) {
  return (
    <TableRow>
      <TableCell colSpan={colSpan} className="py-6 text-center text-muted-foreground">{text}</TableCell>
    </TableRow>
  );
}

function AktifBadge({ aktif }: { aktif: boolean }) {
  return aktif ? (
    <Badge variant="outline" className="border-status-verified/30 bg-status-verified-muted text-status-verified">Aktif</Badge>
  ) : (
    <Badge variant="outline" className="text-muted-foreground">Nonaktif</Badge>
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
    <Alert role="status" className="border-status-pending/30 bg-status-pending-muted">
      <TriangleAlert className="text-status-pending" />
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
      <TriangleAlert />
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
