import { useEffect, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { Camera, RefreshCw, Save, TriangleAlert, Undo2 } from 'lucide-react';
import { Controller, useForm, type FieldErrors, type Resolver } from 'react-hook-form';
import { useBlocker } from 'react-router';
import { toast } from 'sonner';
import type { z } from 'zod';
import { AGAMA, GOLONGAN_DARAH, JENIS_KELAMIN, STATUS_PERNIKAHAN } from '@shared/enums';
import {
  REQUIRED_PROFILE_FIELDS,
  updateProfileRequestSchema,
  type Profile,
  type ProfileResponse,
  type RefResponse,
  type UpdateProfileRequest,
} from '@shared/profile';
import { DatePicker } from '@/components/date-picker';
import { PageHeader } from '@/components/page-header';
import { PhotoCropper } from '@/components/photo-cropper';
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
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { errorMessage, isApiError } from '@/lib/api';
import { initials } from '@/lib/format';
import { cn } from '@/lib/utils';
import { phoneForInput } from './format-values';
import { KepegawaianTab } from './kepegawaian-tab';
import { useProfile, useRefData, useUpdateProfile } from './queries';
import { enumOptions, SelectControl } from './select-control';

const IDENTITAS_FIELDS = [
  'nik',
  'tempatLahir',
  'tanggalLahir',
  'jenisKelamin',
  'agama',
  'pendidikanKode',
  'statusPernikahan',
  'golonganDarah',
] as const;
const KONTAK_FIELDS = ['noHp', 'email', 'alamat'] as const;
const PROFILE_FORM_FIELDS = [...IDENTITAS_FIELDS, ...KONTAK_FIELDS] as const;

type ProfileFormField = (typeof PROFILE_FORM_FIELDS)[number];
/** Every value is a string in the form; '' becomes null through the schema. */
type ProfileFormValues = Record<ProfileFormField, string>;
type ProfileFormOutput = z.output<typeof updateProfileRequestSchema>;
type TabValue = 'identitas' | 'kontak' | 'kepegawaian';

const REQUIRED_TOTAL = Object.keys(REQUIRED_PROFILE_FIELDS).length;
const FORM_ID = 'profil-form';

function isFormField(key: string): key is ProfileFormField {
  return (PROFILE_FORM_FIELDS as readonly string[]).includes(key);
}

function isRequired(field: ProfileFormField): boolean {
  return field in REQUIRED_PROFILE_FIELDS;
}

function toFormValues(p: Profile): ProfileFormValues {
  return {
    nik: p.nik ?? '',
    tempatLahir: p.tempatLahir ?? '',
    tanggalLahir: p.tanggalLahir ?? '',
    jenisKelamin: p.jenisKelamin ?? '',
    agama: p.agama ?? '',
    pendidikanKode: p.pendidikanKode ?? '',
    statusPernikahan: p.statusPernikahan ?? '',
    golonganDarah: p.golonganDarah ?? '',
    noHp: phoneForInput(p.noHp),
    email: p.email ?? '',
    alamat: p.alamat ?? '',
  };
}

function tabForField(field: string): TabValue {
  return (KONTAK_FIELDS as readonly string[]).includes(field) ? 'kontak' : 'identitas';
}

/* -------------------------------------------------------------------------- */
/* Page                                                                       */
/* -------------------------------------------------------------------------- */

export default function ProfilPage() {
  const profileQuery = useProfile();
  const refQuery = useRefData();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Profil Pegawai" description="Lengkapi data diri dan pantau data kepegawaian Anda." />
      {profileQuery.isPending ? (
        <ProfilSkeleton />
      ) : profileQuery.isError ? (
        <Alert variant="destructive" role="alert">
          <TriangleAlert />
          <AlertTitle>Gagal memuat profil</AlertTitle>
          <AlertDescription>
            <p>{errorMessage(profileQuery.error)}</p>
            <Button size="sm" variant="outline" className="mt-2" onClick={() => void profileQuery.refetch()}>
              <RefreshCw data-icon="inline-start" />
              Coba lagi
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <ProfilContent data={profileQuery.data} refData={refQuery.data} refLoading={refQuery.isPending} />
      )}
    </div>
  );
}

function ProfilSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Memuat profil">
      <Card>
        <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <Skeleton className="size-20 rounded-full" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-5 w-56" />
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-2 w-full max-w-sm" />
          </div>
        </CardContent>
      </Card>
      <Skeleton className="h-8 w-72" />
      <Card>
        <CardContent className="grid gap-5 sm:grid-cols-2">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="flex flex-col gap-2">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-8 w-full" />
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Header                                                                     */
/* -------------------------------------------------------------------------- */

function ProfilHeaderCard({ profile, missingFields }: { profile: Profile; missingFields: string[] }) {
  const terisi = REQUIRED_TOTAL - missingFields.length;
  const persen = Math.round((terisi / REQUIRED_TOTAL) * 100);

  return (
    <Card>
      <CardContent className="flex flex-col gap-5 sm:flex-row sm:items-center">
        <div className="relative w-fit shrink-0">
          <Avatar className="size-20">
            {profile.fotoUrl ? <AvatarImage src={profile.fotoUrl} alt={`Foto ${profile.nama}`} /> : null}
            <AvatarFallback className="text-xl font-semibold">{initials(profile.nama)}</AvatarFallback>
          </Avatar>
          <PhotoCropper triggerClassName="absolute -right-1 -bottom-1 rounded-full shadow-sm ring-2 ring-background">
            <Camera />
          </PhotoCropper>
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-lg font-semibold text-foreground">{profile.nama}</h2>
            {profile.statusKepegawaian ? (
              <Badge variant="secondary">{profile.statusKepegawaian}</Badge>
            ) : (
              <Badge variant="outline" className="text-muted-foreground">
                Status belum diisi
              </Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            NIP <span className="font-mono tabular-nums">{profile.nip}</span>
            <span aria-hidden="true"> · </span>
            {profile.role === 'Admin' ? 'Administrator TU' : 'Pegawai'}
          </p>
        </div>

        <div className="flex w-full flex-col gap-2 sm:w-56">
          <div className="flex items-baseline justify-between gap-2 text-sm">
            <span className="text-muted-foreground">Data diri lengkap</span>
            <span className="font-medium tabular-nums">
              {terisi}/{REQUIRED_TOTAL}
            </span>
          </div>
          <Progress
            value={persen}
            aria-label={`Data diri lengkap ${terisi} dari ${REQUIRED_TOTAL}`}
            className={cn('h-2', persen === 100 && '*:bg-status-verified')}
          />
        </div>
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Content + form                                                             */
/* -------------------------------------------------------------------------- */

interface ProfilContentProps {
  data: ProfileResponse;
  refData: RefResponse | undefined;
  refLoading: boolean;
}

function ProfilContent({ data, refData, refLoading }: ProfilContentProps) {
  const { profile, missingFields, pengajuanAktif } = data;
  const [tab, setTab] = useState<TabValue>('identitas');
  const update = useUpdateProfile();

  // Initialised once: background refetches and photo uploads never overwrite unsaved edits.
  const form = useForm<ProfileFormValues, unknown, ProfileFormOutput>({
    // Form keeps plain strings (Select values come from the enums); the schema narrows and maps '' → null.
    resolver: zodResolver(updateProfileRequestSchema) as unknown as Resolver<ProfileFormValues, unknown, ProfileFormOutput>,
    defaultValues: toFormValues(profile),
    mode: 'onTouched',
  });
  const { isDirty, dirtyFields, errors } = form.formState;

  /* ---- dirty guard ---- */
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      isDirty &&
      currentLocation.pathname !== nextLocation.pathname &&
      // Session-expiry and logout redirects must never be held back by the guard.
      nextLocation.pathname !== '/login',
  );
  useEffect(() => {
    if (!isDirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Legacy browsers only show the prompt when returnValue is set.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [isDirty]);

  /* ---- submit ---- */
  const onInvalid = (fieldErrors: FieldErrors<ProfileFormValues>) => {
    const first = PROFILE_FORM_FIELDS.find((key) => fieldErrors[key]);
    if (first) setTab(tabForField(first));
  };

  const onSubmit = form.handleSubmit((values) => {
    const body: Record<string, unknown> = {};
    for (const key of PROFILE_FORM_FIELDS) {
      if (dirtyFields[key]) body[key] = values[key] ?? null;
    }
    if (Object.keys(body).length === 0) return;

    update.mutate(body as UpdateProfileRequest, {
      onSuccess: (res) => {
        form.reset(toFormValues(res.profile));
        toast.success('Perubahan profil berhasil disimpan.');
      },
      onError: (error) => {
        if (isApiError(error, 'VALIDATION_ERROR') && error.fields) {
          let firstField: ProfileFormField | undefined;
          for (const [key, message] of Object.entries(error.fields)) {
            if (isFormField(key)) {
              form.setError(key, { message });
              firstField ??= key;
            } else {
              form.setError('root', { message });
            }
          }
          if (firstField) setTab(tabForField(firstField));
          return;
        }
        if (isApiError(error, 'CONFLICT') && error.fields?.nik) {
          form.setError('nik', { message: error.message || 'NIK sudah digunakan oleh pegawai lain.' }, { shouldFocus: true });
          setTab('identitas');
          return;
        }
        form.setError('root', { message: errorMessage(error) });
      },
    });
  }, onInvalid);

  const resetForm = () => form.reset(toFormValues(profile));

  const tabHasError = (fields: readonly ProfileFormField[]) => fields.some((key) => errors[key]);

  /* ---- field renderers ---- */
  const label = (field: ProfileFormField, text: string) => (
    <FieldLabel htmlFor={field}>
      {text}
      {isRequired(field) ? (
        <span className="text-destructive" aria-hidden="true">
          *
        </span>
      ) : null}
    </FieldLabel>
  );

  const textField = (
    field: ProfileFormField,
    text: string,
    props: React.ComponentProps<typeof Input> = {},
    className?: string,
  ) => {
    const invalid = errors[field] ? true : undefined;
    return (
      <Field data-invalid={invalid} className={className}>
        {label(field, text)}
        <Input id={field} aria-invalid={invalid} aria-required={isRequired(field) || undefined} {...props} {...form.register(field)} />
        <FieldError errors={[errors[field]]} />
      </Field>
    );
  };

  const selectField = (
    field: ProfileFormField,
    text: string,
    options: { value: string; label: string }[],
    extra: { placeholder?: string; disabled?: boolean } = {},
  ) => {
    const invalid = errors[field] ? true : undefined;
    return (
      <Field data-invalid={invalid}>
        {label(field, text)}
        <Controller
          control={form.control}
          name={field}
          render={({ field: f }) => (
            <SelectControl
              id={field}
              value={f.value}
              onChange={f.onChange}
              onBlur={f.onBlur}
              options={options}
              invalid={invalid}
              placeholder={extra.placeholder ?? `Pilih ${text.toLowerCase()}`}
              disabled={extra.disabled}
            />
          )}
        />
        <FieldError errors={[errors[field]]} />
      </Field>
    );
  };

  const pendidikanOptions = (refData?.pendidikan ?? []).map((p) => ({ value: p.kode, label: p.nama }));
  const showFormBar = tab !== 'kepegawaian';

  return (
    <>
      <ProfilHeaderCard profile={profile} missingFields={missingFields} />

      {missingFields.length > 0 ? (
        <Alert className="border-status-pending/30 bg-status-pending-muted">
          <TriangleAlert className="text-status-pending" />
          <AlertTitle>Data diri belum lengkap</AlertTitle>
          <AlertDescription>
            <p>Wajib dilengkapi sebelum mengunggah dokumen.</p>
            <ul className="mt-1 flex flex-wrap gap-1.5">
              {missingFields.map((field) => (
                <li key={field}>
                  <Badge variant="outline" className="bg-background">
                    {field}
                  </Badge>
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      <Tabs value={tab} onValueChange={(value) => setTab(value as TabValue)} className="gap-4">
        <TabsList className="w-full sm:w-fit">
          <TabsTrigger value="identitas">
            Identitas
            {tabHasError(IDENTITAS_FIELDS) ? <span className="size-1.5 rounded-full bg-destructive" aria-label="ada kesalahan" /> : null}
          </TabsTrigger>
          <TabsTrigger value="kontak">
            Kontak
            {tabHasError(KONTAK_FIELDS) ? <span className="size-1.5 rounded-full bg-destructive" aria-label="ada kesalahan" /> : null}
          </TabsTrigger>
          <TabsTrigger value="kepegawaian">Kepegawaian</TabsTrigger>
        </TabsList>

        {/* Only the personal/contact tabs are inside the form; the kepegawaian dialog has its own form. */}
        <form id={FORM_ID} noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
          <TabsContent value="identitas">
            <Card>
              <CardHeader>
                <CardTitle>Identitas</CardTitle>
                <CardDescription>Data pribadi sesuai dokumen kependudukan.</CardDescription>
              </CardHeader>
              <CardContent>
                <FieldGroup className="grid gap-5 sm:grid-cols-2">
                  {textField('nik', 'NIK', { inputMode: 'numeric', maxLength: 16, autoComplete: 'off', placeholder: '16 digit angka' })}
                  {textField('tempatLahir', 'Tempat Lahir', { autoComplete: 'off' })}
                  <Field data-invalid={errors.tanggalLahir ? true : undefined}>
                    {label('tanggalLahir', 'Tanggal Lahir')}
                    <Controller
                      control={form.control}
                      name="tanggalLahir"
                      render={({ field }) => (
                        <DatePicker
                          id="tanggalLahir"
                          value={field.value}
                          onChange={(v) => field.onChange(v)}
                          onBlur={field.onBlur}
                          invalid={!!errors.tanggalLahir}
                          defaultMonth={new Date(1985, 0)}
                          fromYear={1900}
                        />
                      )}
                    />
                    <FieldError errors={[errors.tanggalLahir]} />
                  </Field>
                  {selectField('jenisKelamin', 'Jenis Kelamin', enumOptions(JENIS_KELAMIN))}
                  {selectField('agama', 'Agama', enumOptions(AGAMA))}
                  {selectField('pendidikanKode', 'Pendidikan Terakhir', pendidikanOptions, {
                    placeholder: refLoading ? 'Memuat…' : 'Pilih pendidikan',
                    disabled: refLoading,
                  })}
                  {selectField('statusPernikahan', 'Status Pernikahan', enumOptions(STATUS_PERNIKAHAN))}
                  {selectField('golonganDarah', 'Golongan Darah', enumOptions(GOLONGAN_DARAH))}
                </FieldGroup>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="kontak">
            <Card>
              <CardHeader>
                <CardTitle>Kontak</CardTitle>
                <CardDescription>Digunakan untuk menghubungi Anda terkait administrasi kepegawaian.</CardDescription>
              </CardHeader>
              <CardContent>
                <FieldGroup className="grid gap-5 sm:grid-cols-2">
                  {textField('noHp', 'Nomor HP / WhatsApp', { inputMode: 'tel', type: 'tel', autoComplete: 'tel', placeholder: '081234567890' })}
                  {textField('email', 'Email', { type: 'email', autoComplete: 'email', placeholder: 'nama@contoh.com' })}
                  <Field data-invalid={errors.alamat ? true : undefined} className="sm:col-span-2">
                    {label('alamat', 'Alamat')}
                    <Textarea
                      id="alamat"
                      rows={3}
                      maxLength={500}
                      autoComplete="street-address"
                      aria-invalid={errors.alamat ? true : undefined}
                      aria-required
                      {...form.register('alamat')}
                    />
                    <FieldError errors={[errors.alamat]} />
                  </Field>
                </FieldGroup>
              </CardContent>
            </Card>
          </TabsContent>

          {errors.root?.message && showFormBar ? (
            <Alert variant="destructive" role="alert">
              <TriangleAlert />
              <AlertDescription>{errors.root.message}</AlertDescription>
            </Alert>
          ) : null}

          {showFormBar ? (
            <div className="sticky bottom-0 z-10 -mx-4 flex flex-col-reverse gap-2 border-t bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:mx-0 sm:flex-row sm:items-center sm:justify-end sm:rounded-xl sm:border">
              <p className="text-sm text-muted-foreground sm:mr-auto" aria-live="polite">
                {isDirty ? 'Ada perubahan yang belum disimpan.' : 'Semua perubahan sudah tersimpan.'}
              </p>
              <Button type="button" variant="outline" disabled={!isDirty || update.isPending} onClick={resetForm}>
                <Undo2 data-icon="inline-start" />
                Batalkan
              </Button>
              <Button type="submit" disabled={!isDirty || update.isPending}>
                {update.isPending ? <Spinner data-icon="inline-start" /> : <Save data-icon="inline-start" />}
                Simpan Perubahan
              </Button>
            </div>
          ) : null}
        </form>

        <TabsContent value="kepegawaian">
          <KepegawaianTab profile={profile} pengajuanAktif={pengajuanAktif} refData={refData} />
        </TabsContent>
      </Tabs>

      <AlertDialog open={blocker.state === 'blocked'}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Perubahan belum disimpan</AlertDialogTitle>
            <AlertDialogDescription>
              Data diri yang Anda ubah belum disimpan. Jika meninggalkan halaman ini, perubahan tersebut akan hilang.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => blocker.reset?.()}>Tetap di halaman</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => blocker.proceed?.()}>
              Tinggalkan
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
