import { useEffect, useRef, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { Info, RefreshCw, Save, TriangleAlert, UserPlus } from 'lucide-react';
import { useForm, useWatch, type FieldErrors, type Resolver } from 'react-hook-form';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import {
  AGAMA,
  GOLONGAN_DARAH,
  JENIS_JABATAN,
  JENIS_KELAMIN,
  ROLES,
  STATUS_KEPEGAWAIAN,
  STATUS_PERNIKAHAN,
  type StatusKepegawaian,
} from '@shared/enums';
import { createPegawaiSchema, updatePegawaiSchema, type CreatePegawaiRequest, type UpdatePegawaiRequest } from '@shared/pegawai';
import { KEPEGAWAIAN_LABELS, pangkatForStatus, REQUIRED_PROFILE_FIELDS, type Profile } from '@shared/profile';
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
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useMe } from '@/features/auth/queries';
import { useRefData } from '@/features/profil/queries';
import { enumOptions } from '@/features/profil/select-control';
import { errorMessage, isApiError } from '@/lib/api';
import { DateField, SelectField, TextareaField, TextField } from './fields';
import {
  buildCreatePayload,
  buildUpdatePayload,
  emptyPegawaiForm,
  IDENTITAS_FIELDS,
  isPegawaiFormField,
  KEPEGAWAIAN_FORM_FIELDS,
  KONTAK_FIELDS,
  pangkatFamily,
  PEGAWAI_FORM_FIELDS,
  profileToForm,
  tabForField,
  type PegawaiFormField,
  type PegawaiFormTab,
  type PegawaiFormValues,
} from './pegawai-utils';
import { useCreatePegawai, usePegawaiDetail, useUpdatePegawai } from './queries';

const FORM_ID = 'pegawai-form';
const isRequiredProfile = (field: string) => field in REQUIRED_PROFILE_FIELDS;

interface PegawaiFormSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null = Tambah, number = Edit. */
  pegawaiId: number | null;
}

export function PegawaiFormSheet({ open, onOpenChange, pegawaiId }: PegawaiFormSheetProps) {
  const dirtyRef = useRef(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const isEdit = pegawaiId !== null;

  const requestOpenChange = (next: boolean) => {
    if (!next && dirtyRef.current) {
      setConfirmClose(true);
      return;
    }
    dirtyRef.current = false;
    onOpenChange(next);
  };

  const close = () => {
    dirtyRef.current = false;
    onOpenChange(false);
  };

  return (
    <>
      <Sheet open={open} onOpenChange={requestOpenChange}>
        <SheetContent side="right" className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-2xl">
          <SheetHeader className="border-b pr-12">
            <SheetTitle className="text-base">{isEdit ? 'Edit Data Pegawai' : 'Tambah Pegawai'}</SheetTitle>
            <SheetDescription>
              {isEdit
                ? 'Perubahan data kepegawaian oleh admin langsung berlaku tanpa pengajuan.'
                : 'Isi data minimal (NIP, nama, status kepegawaian). Data lain dapat dilengkapi nanti.'}
            </SheetDescription>
          </SheetHeader>
          {open ? (
            isEdit ? (
              <EditBody key={pegawaiId} id={pegawaiId} dirtyRef={dirtyRef} onDone={close} onCancel={() => requestOpenChange(false)} />
            ) : (
              <PegawaiForm mode="create" dirtyRef={dirtyRef} onDone={close} onCancel={() => requestOpenChange(false)} />
            )
          ) : null}
        </SheetContent>
      </Sheet>

      <AlertDialog open={confirmClose} onOpenChange={setConfirmClose}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Perubahan belum disimpan</AlertDialogTitle>
            <AlertDialogDescription>Data yang Anda isi belum disimpan. Jika formulir ditutup, perubahan tersebut akan hilang.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Lanjutkan mengisi</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setConfirmClose(false);
                close();
              }}
            >
              Buang perubahan
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

interface BodyProps {
  dirtyRef: React.RefObject<boolean>;
  onDone: () => void;
  onCancel: () => void;
}

function EditBody({ id, ...rest }: BodyProps & { id: number }) {
  const detail = usePegawaiDetail(id);
  if (detail.isPending) {
    return (
      <div className="flex flex-col gap-5 p-4" aria-busy="true" aria-label="Memuat data pegawai">
        <Skeleton className="h-8 w-72" />
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="flex flex-col gap-2">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-8 w-full" />
          </div>
        ))}
      </div>
    );
  }
  if (detail.isError) {
    return (
      <div className="p-4">
        <Alert variant="destructive" role="alert">
          <TriangleAlert />
          <AlertTitle>Gagal memuat data pegawai</AlertTitle>
          <AlertDescription>
            <p>{errorMessage(detail.error)}</p>
            <Button size="sm" variant="outline" className="mt-2" onClick={() => void detail.refetch()}>
              <RefreshCw data-icon="inline-start" />
              Coba lagi
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  }
  return (
    <PegawaiForm
      mode="edit"
      profile={detail.data.pegawai}
      reload={async () => (await detail.refetch()).data?.pegawai ?? null}
      {...rest}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* Form                                                                       */
/* -------------------------------------------------------------------------- */

const REQUIRED_MESSAGES: Partial<Record<PegawaiFormField, string>> = {
  statusKepegawaian: 'Pilih status kepegawaian.',
  nama: 'Nama minimal 3 karakter.',
};

/** Validates the API payload with the shared schema; payload keys are the form field names. */
function makeResolver(mode: 'create' | 'edit', getInitial: () => PegawaiFormValues): Resolver<PegawaiFormValues> {
  const createResolver = zodResolver(createPegawaiSchema);
  const updateResolver = zodResolver(updatePegawaiSchema);
  return async (values, context, options) => {
    // expectedUpdatedAt is only a placeholder here; the real one is added on submit.
    const payload = mode === 'create' ? buildCreatePayload(values) : buildUpdatePayload(values, getInitial(), 'x');
    const result =
      mode === 'create'
        ? await createResolver(payload as never, context, options as never)
        : await updateResolver(payload as never, context, options as never);
    const errors: Record<string, { type: string; message?: string }> = {};
    for (const [key, error] of Object.entries(result.errors ?? {})) {
      if (!error) continue;
      const field = isPegawaiFormField(key) ? key : null;
      const friendly = field ? REQUIRED_MESSAGES[field] : undefined;
      const message = (error as { message?: string }).message;
      const useFriendly = friendly && field && (values[field] ?? '').trim().length < 3;
      errors[field ?? 'root'] = { type: 'validation', message: useFriendly ? friendly : message };
    }
    if (Object.keys(errors).length > 0) return { values: {}, errors: errors as FieldErrors<PegawaiFormValues> };
    return { values, errors: {} };
  };
}

type PegawaiFormProps = BodyProps &
  ({ mode: 'create' } | { mode: 'edit'; profile: Profile; reload: () => Promise<Profile | null> });

function PegawaiForm(props: PegawaiFormProps) {
  const { mode, dirtyRef, onDone, onCancel } = props;
  const navigate = useNavigate();
  const { data: me } = useMe();
  const refQuery = useRefData();
  const create = useCreatePegawai();
  const update = useUpdatePegawai();
  const pending = create.isPending || update.isPending;

  const profile = props.mode === 'edit' ? props.profile : null;
  const isSelf = profile !== null && profile.id === me?.id;
  const [tab, setTab] = useState<PegawaiFormTab>('identitas');
  const [conflict, setConflict] = useState<{ message: string; stale: boolean } | null>(null);
  const [reloading, setReloading] = useState(false);
  // The snapshot the form was initialised from: PATCH diff + expectedUpdatedAt come from here,
  // so background refetches never silently change what "unchanged" means.
  const [base, setBase] = useState(() => ({
    values: profile ? profileToForm(profile) : emptyPegawaiForm(),
    updatedAt: profile?.updatedAt ?? '',
  }));
  // Mutable holder read only inside the resolver (validation time), never during render.
  const [baseHolder] = useState(() => ({ values: base.values }));
  const [resolver] = useState(() => makeResolver(mode, () => baseHolder.values));
  const form = useForm<PegawaiFormValues>({ resolver, defaultValues: base.values, mode: 'onTouched' });
  const { errors, isDirty } = form.formState;

  useEffect(() => {
    dirtyRef.current = isDirty;
  }, [isDirty, dirtyRef]);

  const status = useWatch({ control: form.control, name: 'statusKepegawaian' });
  const refData = refQuery.data;
  const pangkatOptions = pangkatForStatus(refData?.pangkat ?? [], (status || null) as StatusKepegawaian | null).map((p) => ({
    value: p.kode,
    label: p.nama,
  }));
  const unitOptions = (refData?.unit ?? []).map((u) => ({ value: String(u.id), label: u.nama }));
  const pendidikanOptions = (refData?.pendidikan ?? []).map((p) => ({ value: p.kode, label: p.nama }));
  const refPlaceholder = refQuery.isPending ? 'Memuat…' : undefined;

  const onStatusChange = (value: string, onChange: (v: string) => void) => {
    const before = pangkatFamily(form.getValues('statusKepegawaian'));
    onChange(value);
    // PNS/CPNS ↔ PPPK use different pangkat lists: the current pangkat is no longer valid.
    if (pangkatFamily(value) !== before && form.getValues('pangkatKode')) {
      form.setValue('pangkatKode', '', { shouldDirty: true });
      toast.info('Pangkat/golongan dikosongkan karena daftar pangkat berbeda untuk status ini.');
    }
  };

  const focusTabOf = (field: string) => setTab(tabForField(field));

  const onInvalid = (fieldErrors: FieldErrors<PegawaiFormValues>) => {
    const first = PEGAWAI_FORM_FIELDS.find((key) => fieldErrors[key]);
    if (first) focusTabOf(first);
  };

  const applyServerError = (error: unknown) => {
    if (isApiError(error, 'VALIDATION_ERROR') && error.fields) {
      let first: PegawaiFormField | undefined;
      for (const [key, message] of Object.entries(error.fields)) {
        if (isPegawaiFormField(key)) {
          form.setError(key, { message });
          first ??= key;
        } else {
          form.setError('root', { message });
        }
      }
      if (first) focusTabOf(first);
      return;
    }
    if (isApiError(error, 'CONFLICT')) {
      // Branch on the machine-readable field key, never on message text.
      const message = error.message;
      const conflictField = error.fields ? Object.keys(error.fields)[0] : undefined;
      if (conflictField === 'nik' || (conflictField === 'nip' && mode === 'create')) {
        form.setError(conflictField, { message }, { shouldFocus: true });
        setTab('identitas');
        return;
      }
      setConflict({ message, stale: mode === 'edit' && conflictField === 'stale' });
      return;
    }
    form.setError('root', { message: errorMessage(error) });
  };

  const onSubmit = form.handleSubmit((values) => {
    setConflict(null);
    if (props.mode === 'create') {
      create.mutate(buildCreatePayload(values) as CreatePegawaiRequest, {
        onSuccess: (res) => {
          const id = res?.pegawai?.id;
          toast.success(`${values.nama.trim()} berhasil ditambahkan.`, {
            description: 'Password awal = 6 digit terakhir NIP.',
            action: id ? { label: 'Lihat detail', onClick: () => void navigate(`/admin/pegawai/${id}`) } : undefined,
          });
          onDone();
        },
        onError: applyServerError,
      });
      return;
    }
    const body = buildUpdatePayload(values, base.values, base.updatedAt);
    if (Object.keys(body).length === 0) {
      onDone();
      return;
    }
    update.mutate(
      { id: props.profile.id, body: body as UpdatePegawaiRequest },
      {
        onSuccess: () => {
          toast.success('Data pegawai berhasil disimpan.');
          onDone();
        },
        onError: applyServerError,
      },
    );
  }, onInvalid);

  const reload = async () => {
    if (props.mode !== 'edit') return;
    setReloading(true);
    try {
      const fresh = await props.reload();
      if (fresh) {
        const values = profileToForm(fresh);
        setBase({ values, updatedAt: fresh.updatedAt });
        baseHolder.values = values;
        form.reset(values);
        setConflict(null);
        toast.info('Data terbaru dimuat. Periksa kembali lalu ulangi perubahan Anda.');
      }
    } finally {
      setReloading(false);
    }
  };

  const tabHasError = (fields: readonly PegawaiFormField[]) => fields.some((key) => errors[key]);
  const errorDot = <span className="size-1.5 rounded-full bg-destructive" aria-label="ada kesalahan" />;
  const common = { errors, control: form.control };
  const reg = { errors, register: form.register };

  return (
    <form id={FORM_ID} noValidate onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        {conflict ? (
          <Alert variant="destructive" role="alert">
            <TriangleAlert />
            <AlertTitle>{conflict.stale ? 'Data pegawai telah berubah' : 'Tidak dapat menyimpan'}</AlertTitle>
            <AlertDescription>
              <p>{conflict.message}</p>
              {conflict.stale ? (
                <Button type="button" size="sm" variant="outline" className="mt-2" onClick={() => void reload()} disabled={reloading}>
                  {reloading ? <Spinner data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" />}
                  Muat ulang
                </Button>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}
        {errors.root?.message ? (
          <Alert variant="destructive" role="alert">
            <TriangleAlert />
            <AlertDescription>{errors.root.message}</AlertDescription>
          </Alert>
        ) : null}

        <Tabs value={tab} onValueChange={(v) => setTab(v as PegawaiFormTab)} className="gap-4">
          <TabsList className="w-full sm:w-fit">
            <TabsTrigger value="identitas">
              Identitas
              {tabHasError(IDENTITAS_FIELDS) ? errorDot : null}
            </TabsTrigger>
            <TabsTrigger value="kepegawaian">
              Kepegawaian
              {tabHasError(KEPEGAWAIAN_FORM_FIELDS) ? errorDot : null}
            </TabsTrigger>
            <TabsTrigger value="kontak">
              Kontak
              {tabHasError(KONTAK_FIELDS) ? errorDot : null}
            </TabsTrigger>
          </TabsList>

          {/* forceMount keeps every field registered so validation errors on hidden tabs are kept. */}
          <TabsContent value="identitas" forceMount className="data-[state=inactive]:hidden">
            <FieldGroup className="grid gap-5 sm:grid-cols-2">
              {profile ? (
                <Field>
                  <FieldLabel htmlFor="pegawai-nip-readonly">NIP</FieldLabel>
                  <Input id="pegawai-nip-readonly" value={profile.nip} readOnly className="font-mono tabular-nums" />
                  <FieldDescription>NIP tidak dapat diubah.</FieldDescription>
                </Field>
              ) : (
                <TextField
                  name="nip"
                  label="NIP"
                  required
                  {...reg}
                  inputProps={{ inputMode: 'numeric', maxLength: 18, autoComplete: 'off', placeholder: '18 digit angka', className: 'font-mono tabular-nums' }}
                />
              )}
              <TextField name="nama" label="Nama lengkap" required {...reg} inputProps={{ autoComplete: 'off', placeholder: 'Sesuai SK, termasuk gelar' }} />
              <SelectField
                name="role"
                label="Peran"
                {...common}
                options={ROLES.map((r) => ({ value: r, label: r === 'Admin' ? 'Admin (Administrator TU)' : 'Pegawai' }))}
                disabled={isSelf}
                description={isSelf ? 'Anda tidak dapat mengubah peran akun sendiri.' : undefined}
              />
              <TextField
                name="nik"
                label="NIK"
                required={isRequiredProfile('nik')}
                {...reg}
                inputProps={{ inputMode: 'numeric', maxLength: 16, autoComplete: 'off', placeholder: '16 digit angka' }}
              />
              <TextField name="tempatLahir" label="Tempat Lahir" required={isRequiredProfile('tempatLahir')} {...reg} inputProps={{ autoComplete: 'off' }} />
              <DateField
                name="tanggalLahir"
                label="Tanggal Lahir"
                required={isRequiredProfile('tanggalLahir')}
                {...common}
                defaultMonth={new Date(1985, 0)}
                fromYear={1900}
              />
              <SelectField name="jenisKelamin" label="Jenis Kelamin" required={isRequiredProfile('jenisKelamin')} {...common} options={enumOptions(JENIS_KELAMIN)} />
              <SelectField name="agama" label="Agama" required={isRequiredProfile('agama')} {...common} options={enumOptions(AGAMA)} />
              <SelectField
                name="pendidikanKode"
                label="Pendidikan Terakhir"
                required={isRequiredProfile('pendidikanKode')}
                {...common}
                options={pendidikanOptions}
                placeholder={refPlaceholder}
                disabled={refQuery.isPending}
              />
              <SelectField
                name="statusPernikahan"
                label="Status Pernikahan"
                required={isRequiredProfile('statusPernikahan')}
                {...common}
                options={enumOptions(STATUS_PERNIKAHAN)}
              />
              <SelectField name="golonganDarah" label="Golongan Darah" {...common} options={enumOptions(GOLONGAN_DARAH)} />
            </FieldGroup>
          </TabsContent>

          <TabsContent value="kepegawaian" forceMount className="data-[state=inactive]:hidden">
            <FieldGroup className="grid gap-5 sm:grid-cols-2">
              <SelectField
                name="statusKepegawaian"
                label={KEPEGAWAIAN_LABELS.statusKepegawaian}
                required
                {...common}
                options={enumOptions(STATUS_KEPEGAWAIAN)}
                onValueChange={onStatusChange}
                description="Menentukan dokumen wajib dan daftar pangkat."
              />
              <SelectField
                name="pangkatKode"
                label={KEPEGAWAIAN_LABELS.pangkatKode}
                {...common}
                options={pangkatOptions}
                placeholder={refPlaceholder ?? (status ? 'Pilih pangkat/golongan' : 'Pilih status kepegawaian dulu')}
                disabled={refQuery.isPending || !status}
              />
              <DateField name="tmtPangkat" label={KEPEGAWAIAN_LABELS.tmtPangkat} {...common} fromYear={1970} />
              <TextField name="jabatan" label={KEPEGAWAIAN_LABELS.jabatan} {...reg} inputProps={{ autoComplete: 'off' }} />
              <SelectField name="jenisJabatan" label={KEPEGAWAIAN_LABELS.jenisJabatan} {...common} options={enumOptions(JENIS_JABATAN)} />
              <DateField name="tmtJabatan" label={KEPEGAWAIAN_LABELS.tmtJabatan} {...common} fromYear={1970} />
              <SelectField
                name="unitId"
                label={KEPEGAWAIAN_LABELS.unitId}
                {...common}
                options={unitOptions}
                placeholder={refPlaceholder}
                disabled={refQuery.isPending}
                className="sm:col-span-2"
              />
            </FieldGroup>
          </TabsContent>

          <TabsContent value="kontak" forceMount className="data-[state=inactive]:hidden">
            <FieldGroup className="grid gap-5 sm:grid-cols-2">
              <TextField
                name="noHp"
                label="Nomor HP / WhatsApp"
                required={isRequiredProfile('noHp')}
                {...reg}
                inputProps={{ type: 'tel', inputMode: 'tel', autoComplete: 'off', placeholder: '081234567890' }}
              />
              <TextField
                name="email"
                label="Email"
                required={isRequiredProfile('email')}
                {...reg}
                inputProps={{ type: 'email', autoComplete: 'off', placeholder: 'nama@contoh.com' }}
              />
              <TextareaField name="alamat" label="Alamat" required={isRequiredProfile('alamat')} {...reg} maxLength={500} className="sm:col-span-2" />
            </FieldGroup>
          </TabsContent>
        </Tabs>

        {mode === 'create' ? (
          <Alert>
            <Info />
            <AlertDescription>Password awal = 6 digit terakhir NIP. Pegawai tidak wajib menggantinya, tetapi disarankan.</AlertDescription>
          </Alert>
        ) : (
          <p className="text-xs text-muted-foreground">
            Kolom bertanda <span className="text-destructive">*</span> wajib dilengkapi pegawai sebelum mengunggah dokumen, tetapi boleh dikosongkan di sini.
          </p>
        )}
      </div>

      <SheetFooter className="flex-col-reverse gap-2 border-t sm:flex-row sm:items-center sm:justify-end">
        <p className="text-sm text-muted-foreground sm:mr-auto" aria-live="polite">
          {isDirty ? 'Ada perubahan yang belum disimpan.' : mode === 'edit' ? 'Belum ada perubahan.' : ''}
        </p>
        <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
          Batal
        </Button>
        <Button type="submit" disabled={pending || (mode === 'edit' && !isDirty)}>
          {pending ? <Spinner data-icon="inline-start" /> : mode === 'create' ? <UserPlus data-icon="inline-start" /> : <Save data-icon="inline-start" />}
          {mode === 'create' ? 'Tambah Pegawai' : 'Simpan Perubahan'}
        </Button>
      </SheetFooter>
    </form>
  );
}
