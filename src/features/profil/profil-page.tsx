import { useEffect } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { Camera, CircleCheck, TriangleAlert } from 'lucide-react';
import { Controller, useForm, type Resolver } from 'react-hook-form';
import { useBlocker, useLocation } from 'react-router';
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
import { StickySaveBar } from '@/components/form-patterns';
import { PageHeader } from '@/components/page-header';
import { PhotoCropper } from '@/components/photo-cropper';
import { SectionCard } from '@/components/section-card';
import { ErrorState } from '@/components/states';
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
import { Card } from '@/components/ui/card';
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { errorMessage, isApiError } from '@/lib/api';
import { initials } from '@/lib/format';
import { cn } from '@/lib/utils';
import { formatKepegawaianValue, phoneForInput } from './format-values';
import { KepegawaianCard, RiwayatPengajuanCard } from './kepegawaian-tab';
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

const REQUIRED_TOTAL = Object.keys(REQUIRED_PROFILE_FIELDS).length;

/** Same order as the admin employee sheet (identitas → kepegawaian → kontak). */
const SECTIONS = [
  { id: 'identitas', label: 'Identitas' },
  { id: 'kepegawaian', label: 'Kepegawaian' },
  { id: 'kontak', label: 'Kontak' },
  { id: 'riwayat-pengajuan', label: 'Riwayat pengajuan' },
] as const;

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
        <Card className="py-0">
          <ErrorState error={profileQuery.error} title="Gagal memuat profil" onRetry={() => void profileQuery.refetch()} retrying={profileQuery.isFetching} />
        </Card>
      ) : (
        <ProfilContent data={profileQuery.data} refData={refQuery.data} refLoading={refQuery.isPending} />
      )}
    </div>
  );
}

function ProfilSkeleton() {
  return (
    <div className="grid items-start gap-6 lg:grid-cols-[18rem_minmax(0,1fr)] xl:grid-cols-[20rem_minmax(0,1fr)]" aria-busy="true" aria-label="Memuat profil">
      <Skeleton className="h-96 rounded-xl" />
      <div className="flex flex-col gap-6">
        <Card>
          <div className="grid gap-5 px-5 sm:grid-cols-2">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="flex flex-col gap-2">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-9 w-full" />
              </div>
            ))}
          </div>
        </Card>
        <Skeleton className="h-48 rounded-xl" />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Aside: identity card                                                       */
/* -------------------------------------------------------------------------- */

function ProfilAside({ profile, missingFields, refData }: { profile: Profile; missingFields: string[]; refData: RefResponse | undefined }) {
  const terisi = REQUIRED_TOTAL - missingFields.length;
  const done = missingFields.length === 0;

  return (
    <aside aria-label="Ringkasan profil" className="lg:sticky lg:top-20">
      <Card className="gap-0 py-0">
        <div className="flex flex-col items-center gap-3 px-5 pt-6 pb-5 text-center">
          <div className="relative">
            <Avatar className="size-24">
              {profile.fotoUrl ? <AvatarImage src={profile.fotoUrl} alt={`Foto ${profile.nama}`} /> : null}
              <AvatarFallback className="text-2xl font-semibold">{initials(profile.nama)}</AvatarFallback>
            </Avatar>
            <PhotoCropper triggerClassName="absolute right-0 bottom-0 rounded-full shadow-pop ring-2 ring-card">
              <Camera />
            </PhotoCropper>
          </div>
          <div className="flex flex-col gap-0.5">
            <h2 className="text-h2 text-balance text-foreground">{profile.nama}</h2>
            <p className="text-sm text-muted-foreground tabular-nums">NIP {profile.nip}</p>
          </div>
          <div className="flex flex-wrap justify-center gap-1.5">
            {profile.statusKepegawaian ? (
              <Badge variant="secondary">{profile.statusKepegawaian}</Badge>
            ) : (
              <Badge variant="outline" className="text-muted-foreground">
                Status belum diisi
              </Badge>
            )}
            <Badge variant="outline">{profile.role === 'Admin' ? 'Administrator TU' : 'Pegawai'}</Badge>
          </div>
        </div>

        <div className="flex flex-col gap-2 border-t px-5 py-4">
          <div className="flex items-baseline justify-between gap-2 text-sm">
            <span className="text-muted-foreground">Data diri terisi</span>
            <span className={cn('font-medium tabular-nums', done && 'text-status-verified')}>
              {terisi}/{REQUIRED_TOTAL}
            </span>
          </div>
          <div role="img" aria-label={`Data diri terisi ${terisi} dari ${REQUIRED_TOTAL}`} className="flex h-1.5 overflow-hidden rounded-full bg-muted">
            <span className={cn('h-full rounded-full', done ? 'bg-status-verified' : 'bg-primary')} style={{ width: `${(terisi / REQUIRED_TOTAL) * 100}%` }} />
          </div>
          {done ? (
            <p className="flex items-center gap-1.5 text-xs text-status-verified">
              <CircleCheck className="size-3.5" aria-hidden="true" />
              Lengkap, dokumen dapat diunggah.
            </p>
          ) : (
            <div className="flex flex-col gap-1.5">
              <p className="text-xs text-muted-foreground">Wajib diisi sebelum mengunggah dokumen:</p>
              <ul className="flex flex-wrap gap-1">
                {missingFields.map((field) => (
                  <li key={field}>
                    <Badge variant="outline" className="border-status-pending/25 bg-status-pending-muted text-status-pending">
                      {field}
                    </Badge>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <dl className="grid gap-3 border-t px-5 py-4 text-sm">
          {(['pangkatKode', 'jabatan', 'unitId'] as const).map((field) => (
            <div key={field} className="flex flex-col gap-0.5">
              <dt className="text-eyebrow text-muted-foreground uppercase">{field === 'pangkatKode' ? 'Pangkat' : field === 'jabatan' ? 'Jabatan' : 'Unit'}</dt>
              <dd className="font-medium break-words text-foreground">{formatKepegawaianValue(field, profile[field], refData)}</dd>
            </div>
          ))}
        </dl>

        <nav aria-label="Bagian profil" className="hidden flex-col border-t p-2 lg:flex">
          {SECTIONS.map((section) => (
            <a
              key={section.id}
              href={`#${section.id}`}
              className="rounded-md px-3 py-1.5 text-sm text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              {section.label}
            </a>
          ))}
        </nav>
      </Card>
    </aside>
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
  const update = useUpdateProfile();
  const { hash } = useLocation();

  // Initialised once: background refetches and photo uploads never overwrite unsaved edits.
  const form = useForm<ProfileFormValues, unknown, ProfileFormOutput>({
    // Form keeps plain strings (Select values come from the enums); the schema narrows and maps '' → null.
    resolver: zodResolver(updateProfileRequestSchema) as unknown as Resolver<ProfileFormValues, unknown, ProfileFormOutput>,
    defaultValues: toFormValues(profile),
    mode: 'onTouched',
  });
  const { isDirty, dirtyFields, errors } = form.formState;

  // `/profil#kepegawaian` (Beranda, Arsip): the sections render after the profile loads, so scroll then.
  useEffect(() => {
    const id = hash.slice(1);
    if (!id) return;
    requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: 'start' }));
  }, [hash]);

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
  // Both section forms (Identitas, Kontak) submit the same react-hook-form state; invalid fields get focus.
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
          if (firstField) form.setFocus(firstField);
          return;
        }
        if (isApiError(error, 'CONFLICT') && error.fields?.nik) {
          form.setError('nik', { message: error.message || 'NIK sudah digunakan oleh pegawai lain.' }, { shouldFocus: true });
          return;
        }
        form.setError('root', { message: errorMessage(error) });
      },
    });
  });

  const resetForm = () => form.reset(toFormValues(profile));

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

  const textField = (field: ProfileFormField, text: string, props: React.ComponentProps<typeof Input> = {}, className?: string) => {
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
              ref={f.ref}
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

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[18rem_minmax(0,1fr)] xl:grid-cols-[20rem_minmax(0,1fr)]">
      <ProfilAside profile={profile} missingFields={missingFields} refData={refData} />

      <div className="flex min-w-0 flex-col gap-6">
        <form noValidate onSubmit={onSubmit}>
          <SectionCard id="identitas" className="scroll-mt-20" title="Identitas" description="Data pribadi sesuai dokumen kependudukan.">
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
          </SectionCard>
        </form>

        <KepegawaianCard id="kepegawaian" className="scroll-mt-20" profile={profile} pengajuanAktif={pengajuanAktif} refData={refData} />

        <form noValidate onSubmit={onSubmit}>
          <SectionCard id="kontak" className="scroll-mt-20" title="Kontak" description="Digunakan untuk menghubungi Anda terkait administrasi kepegawaian.">
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
          </SectionCard>
        </form>

        <StickySaveBar
          dirty={isDirty}
          saving={update.isPending}
          onSave={() => void onSubmit()}
          onDiscard={resetForm}
          message={
            errors.root?.message ? (
              <span role="alert" className="flex items-center gap-2 text-destructive">
                <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
                {errors.root.message}
              </span>
            ) : undefined
          }
        />

        <RiwayatPengajuanCard id="riwayat-pengajuan" className="scroll-mt-20" refData={refData} />
      </div>

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
    </div>
  );
}
