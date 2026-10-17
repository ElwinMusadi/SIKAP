import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { RefreshCw, Save, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { STATUS_KEPEGAWAIAN, type StatusKepegawaian } from '@shared/enums';
import type { AdminJenisDokumen } from '@shared/administrasi';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { errorMessage, isApiError } from '@/lib/api';
import {
  buildCreatePayload,
  buildUpdatePayload,
  emptyJenisForm,
  impactfulChanges,
  isFormDirty,
  jenisToForm,
  mapFieldErrors,
  type JenisForm,
  type JenisFormErrors,
} from './jenis-utils';
import { useCreateJenis, useUpdateJenis } from './queries';

export type JenisDialogState = { mode: 'create' } | { mode: 'edit'; item: AdminJenisDokumen } | null;

interface Props {
  state: JenisDialogState;
  onClose: () => void;
  /** Latest server copy of the row being edited (may change through background refetch). */
  latest: AdminJenisDokumen | undefined;
  nextUrutan: number;
  /** Refetches the list; resolves with the fresh row (undefined if gone) and rejects on failure. */
  onRefetch: () => Promise<AdminJenisDokumen | undefined>;
  kategoriOptions: string[];
}

type BodyProps = Omit<Props, 'state'> & {
  state: NonNullable<JenisDialogState>;
  create: ReturnType<typeof useCreateJenis>;
  update: ReturnType<typeof useUpdateJenis>;
};

export function JenisDialog({ state, onClose, latest, nextUrutan, onRefetch, kategoriOptions }: Props) {
  // Single mutation instances shared with the form, so the dialog sees the real pending state.
  const create = useCreateJenis();
  const update = useUpdateJenis();
  const busy = create.isPending || update.isPending;
  const block = (event: Event) => {
    if (busy) event.preventDefault();
  };
  return (
    <Dialog open={state !== null} onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent
        className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-xl"
        onEscapeKeyDown={block}
        onInteractOutside={block}
        aria-busy={busy || undefined}
      >
        {state ? (
          <JenisFormBody
            // New session per open/edit target: the form never inherits stale state.
            key={state.mode === 'edit' ? `edit-${state.item.id}` : 'create'}
            state={state}
            latest={latest}
            nextUrutan={nextUrutan}
            onRefetch={onRefetch}
            onClose={onClose}
            kategoriOptions={kategoriOptions}
            create={create}
            update={update}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function JenisFormBody({ state, latest, nextUrutan, onRefetch, onClose, kategoriOptions, create, update }: BodyProps) {
  const id = useId();
  // Snapshot taken when the dialog opened; background refetches never overwrite it silently.
  const [original, setOriginal] = useState<AdminJenisDokumen | null>(state.mode === 'edit' ? state.item : null);
  const [initial, setInitial] = useState<JenisForm>(() => (state.mode === 'edit' ? jenisToForm(state.item) : emptyJenisForm(nextUrutan)));
  const [form, setForm] = useState<JenisForm>(initial);
  const [errors, setErrors] = useState<JenisFormErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [refetching, setRefetching] = useState(false);
  const [refetchError, setRefetchError] = useState<string | null>(null);
  // Row returned by the explicit refetch after a 409; preferred over the background `latest` prop.
  const [fetched, setFetched] = useState<AdminJenisDokumen | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const busy = create.isPending || update.isPending;
  const editing = original !== null;
  const dirty = isFormDirty(form, initial);
  const changedRemotely = !!original && !!latest && latest.updatedAt !== original.updatedAt;
  // After a 409 only the explicitly refetched row counts (its timestamp may equal ours);
  // otherwise a background refetch with a newer updatedAt is offered.
  const candidate = stale ? fetched : changedRemotely ? (fetched ?? latest ?? null) : null;
  const canLoadLatest = !!candidate && !refetching && !busy;
  const impact = impactfulChanges(form, original);
  const needsConfirm = impact.wajib || impact.aktif;

  const set = <K extends keyof JenisForm>(key: K, value: JenisForm[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
    setFormError(null);
    setConfirming(false);
  };
  const toggleStatus = (status: StatusKepegawaian, checked: boolean) =>
    set('wajibUntuk', checked ? [...form.wajibUntuk.filter((s) => s !== status), status] : form.wajibUntuk.filter((s) => s !== status));

  const applyLatest = () => {
    setConfirmDiscard(false);
    if (!candidate) return;
    const next = jenisToForm(candidate);
    setOriginal(candidate);
    setInitial(next);
    setForm(next);
    setFetched(null);
    setErrors({});
    setFormError(null);
    setStale(false);
    setRefetchError(null);
    setConfirming(false);
  };
  const loadLatest = () => {
    if (!canLoadLatest) return;
    if (dirty) setConfirmDiscard(true);
    else applyLatest();
  };

  /** Explicit refetch after a stale 409. Never touches the form; failures keep the edit. */
  const refreshLatest = async () => {
    if (!original) return;
    setRefetching(true);
    setRefetchError(null);
    try {
      const row = await onRefetch();
      if (!mounted.current) return;
      if (row) setFetched(row);
      else setRefetchError('Jenis dokumen ini tidak ditemukan lagi. Tutup dialog lalu muat ulang halaman.');
    } catch (error) {
      if (mounted.current) setRefetchError(errorMessage(error));
    } finally {
      if (mounted.current) setRefetching(false);
    }
  };

  const save = async () => {
    if (busyRef.current) return;
    const built = original
      ? (() => {
          const result = buildUpdatePayload(form, original);
          return result.ok ? { ok: true as const, run: () => update.mutateAsync({ id: original.id, body: result.data }) } : result;
        })()
      : (() => {
          const result = buildCreatePayload(form);
          return result.ok ? { ok: true as const, run: () => create.mutateAsync(result.data) } : result;
        })();
    if (!built.ok) {
      setErrors(built.errors);
      if (built.errors.form) setFormError(built.errors.form);
      setConfirming(false);
      return;
    }
    busyRef.current = true;
    setFormError(null);
    try {
      await built.run();
      toast.success(original ? 'Jenis dokumen diperbarui.' : 'Jenis dokumen ditambahkan.');
      onClose();
    } catch (error) {
      if (!mounted.current) return;
      setConfirming(false);
      if (isApiError(error) && error.fields?.stale) {
        setStale(true);
        void refreshLatest();
      } else if (isApiError(error) && error.fields) {
        const mapped = mapFieldErrors(error.fields);
        setErrors(mapped);
        setFormError(mapped.form ?? errorMessage(error));
      } else {
        setFormError(errorMessage(error));
      }
    } finally {
      busyRef.current = false;
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy || (editing && !dirty)) return;
    if (needsConfirm && !confirming) {
      setConfirming(true);
      return;
    }
    void save();
  };

  const err = (key: keyof JenisForm) => (errors[key] ? { invalid: true, id: `${id}-${key}-error` } : null);
  const fieldProps = (key: keyof JenisForm) => {
    const e = err(key);
    return { 'aria-invalid': e ? true : undefined, 'aria-describedby': e ? e.id : undefined } as const;
  };

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>{editing ? `Ubah ${original.nama}` : 'Tambah jenis dokumen'}</DialogTitle>
        <DialogDescription>
          {editing ? 'ID jenis tidak dapat diubah karena dipakai pada arsip dokumen.' : 'ID tidak dapat diubah setelah disimpan. Jenis dokumen tidak dapat dihapus, hanya dinonaktifkan.'}
        </DialogDescription>
      </DialogHeader>

      {stale || changedRemotely ? (
        <Alert variant={stale ? 'destructive' : 'default'} role={stale ? 'alert' : 'status'}>
          <TriangleAlert />
          <AlertTitle>{stale ? 'Gagal menyimpan: data sudah berubah' : 'Data ini baru saja diubah'}</AlertTitle>
          <AlertDescription>
            <p>Admin lain telah memperbarui jenis dokumen ini. Muat versi terbaru lalu terapkan ulang perubahan Anda.</p>
            {refetchError ? <p className="mt-1 font-medium">Gagal mengambil versi terbaru: {refetchError}</p> : null}
            <div className="mt-2 flex flex-wrap gap-2">
              {refetchError || (stale && !candidate && !refetching) ? (
                <Button type="button" size="sm" variant="outline" onClick={() => void refreshLatest()} disabled={busy}>
                  <RefreshCw data-icon="inline-start" />
                  Coba ambil lagi
                </Button>
              ) : null}
              <Button type="button" size="sm" variant="outline" onClick={loadLatest} disabled={!canLoadLatest}>
                {refetching ? <Spinner data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" />}
                {refetching ? 'Mengambil versi terbaru…' : 'Muat versi terbaru'}
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ) : null}

      <AlertDialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Buang perubahan yang belum disimpan?</AlertDialogTitle>
            <AlertDialogDescription>
              Isian formulir akan diganti dengan versi terbaru dari server. Perubahan Anda perlu diterapkan ulang.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Tetap edit</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={applyLatest}>Buang &amp; muat terbaru</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <FieldGroup>
        <Field data-invalid={err('id') ? true : undefined} data-disabled={editing || busy || undefined}>
          <FieldLabel htmlFor={`${id}-id`}>ID jenis</FieldLabel>
          <Input
            id={`${id}-id`}
            value={form.id}
            onChange={(e) => set('id', e.target.value.toUpperCase())}
            readOnly={editing}
            disabled={busy}
            className="font-mono"
            maxLength={64}
            autoComplete="off"
            spellCheck={false}
            {...fieldProps('id')}
          />
          {!editing ? <FieldDescription>Format DOC-NAMA, huruf kapital/angka, contoh DOC-SK-CPNS.</FieldDescription> : null}
          {errors.id ? <FieldError id={`${id}-id-error`}>{errors.id}</FieldError> : null}
        </Field>
        <Field data-invalid={err('nama') ? true : undefined}>
          <FieldLabel htmlFor={`${id}-nama`}>Nama</FieldLabel>
          <Input id={`${id}-nama`} value={form.nama} onChange={(e) => set('nama', e.target.value)} disabled={busy} maxLength={150} {...fieldProps('nama')} />
          {errors.nama ? <FieldError id={`${id}-nama-error`}>{errors.nama}</FieldError> : null}
        </Field>
        <div className="grid gap-5 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
          <Field data-invalid={err('kategori') ? true : undefined}>
            <FieldLabel htmlFor={`${id}-kategori`}>Kategori</FieldLabel>
            <Input
              id={`${id}-kategori`}
              value={form.kategori}
              onChange={(e) => set('kategori', e.target.value)}
              disabled={busy}
              maxLength={100}
              list={`${id}-kategori-list`}
              {...fieldProps('kategori')}
            />
            <datalist id={`${id}-kategori-list`}>
              {kategoriOptions.map((k) => <option key={k} value={k} />)}
            </datalist>
            {errors.kategori ? <FieldError id={`${id}-kategori-error`}>{errors.kategori}</FieldError> : null}
          </Field>
          <Field data-invalid={err('urutan') ? true : undefined}>
            <FieldLabel htmlFor={`${id}-urutan`}>Urutan</FieldLabel>
            <Input id={`${id}-urutan`} type="number" inputMode="numeric" min={0} max={10000} step={1} value={form.urutan} onChange={(e) => set('urutan', e.target.value)} disabled={busy} {...fieldProps('urutan')} />
            {errors.urutan ? <FieldError id={`${id}-urutan-error`}>{errors.urutan}</FieldError> : null}
          </Field>
          <Field data-invalid={err('maxMb') ? true : undefined}>
            <FieldLabel htmlFor={`${id}-max`}>Maks. (MB)</FieldLabel>
            <Input id={`${id}-max`} type="number" inputMode="decimal" min={1} max={5} step={0.5} value={form.maxMb} onChange={(e) => set('maxMb', e.target.value)} disabled={busy} {...fieldProps('maxMb')} />
            {errors.maxMb ? <FieldError id={`${id}-maxMb-error`}>{errors.maxMb}</FieldError> : null}
          </Field>
        </div>

        <FieldSet disabled={busy} data-invalid={errors.wajibUntuk ? true : undefined}>
          <FieldLegend variant="label">Wajib untuk status kepegawaian</FieldLegend>
          <FieldDescription>Kosongkan jika dokumen bersifat opsional untuk semua pegawai.</FieldDescription>
          <FieldGroup data-slot="checkbox-group" className="flex-row flex-wrap gap-x-6">
            {STATUS_KEPEGAWAIAN.map((status) => (
              <Field key={status} orientation="horizontal" className="w-auto">
                <Checkbox
                  id={`${id}-wajib-${status}`}
                  checked={form.wajibUntuk.includes(status)}
                  onCheckedChange={(checked) => toggleStatus(status, checked === true)}
                />
                <FieldLabel htmlFor={`${id}-wajib-${status}`} className="font-normal">{status}</FieldLabel>
              </Field>
            ))}
          </FieldGroup>
          {errors.wajibUntuk ? <FieldError>{errors.wajibUntuk}</FieldError> : null}
        </FieldSet>

        <Field orientation="horizontal" data-disabled={busy || undefined}>
          <FieldContent>
            <FieldLabel htmlFor={`${id}-aktif`}>Aktif</FieldLabel>
            <FieldDescription id={`${id}-aktif-description`}>
              Jenis nonaktif disembunyikan dari unggahan baru dan perhitungan kelengkapan. Arsip yang ada tetap tersimpan.
            </FieldDescription>
          </FieldContent>
          <Switch id={`${id}-aktif`} checked={form.aktif} onCheckedChange={(checked) => set('aktif', checked)} disabled={busy} aria-describedby={`${id}-aktif-description`} />
        </Field>

        {confirming ? (
          <Alert role="alert" className="border-status-pending/30 bg-status-pending-muted">
            <TriangleAlert className="text-status-pending" />
            <AlertTitle>Konfirmasi perubahan berdampak luas</AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-4">
                {impact.wajib ? (
                  <li>Status wajib berlaku seketika dan surut untuk <strong>semua pegawai</strong> dengan status terpilih; persentase kelengkapan dihitung ulang.</li>
                ) : null}
                {impact.aktif ? (
                  <li>
                    {form.aktif
                      ? 'Mengaktifkan kembali jenis ini membuatnya muncul lagi di unggahan dan kelengkapan semua pegawai.'
                      : 'Menonaktifkan jenis ini menyembunyikannya dari unggahan baru dan kelengkapan semua pegawai. Arsip dokumen tidak dihapus.'}
                  </li>
                ) : null}
              </ul>
              <p className="mt-1">Tekan “Ya, simpan” untuk melanjutkan.</p>
            </AlertDescription>
          </Alert>
        ) : null}

        {formError ? (
          <Alert variant="destructive" role="alert">
            <TriangleAlert />
            <AlertTitle>Gagal menyimpan</AlertTitle>
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        ) : null}
      </FieldGroup>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={confirming ? () => setConfirming(false) : onClose} disabled={busy}>
          {confirming ? 'Kembali' : 'Batal'}
        </Button>
        <Button type="submit" disabled={busy || stale || (editing && !dirty)}>
          {busy ? <Spinner data-icon="inline-start" /> : <Save data-icon="inline-start" />}
          {confirming ? 'Ya, simpan' : editing ? 'Simpan perubahan' : 'Tambah jenis'}
        </Button>
      </DialogFooter>
    </form>
  );
}
