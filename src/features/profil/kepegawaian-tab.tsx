import { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { FileClock, History, Lock, Pencil, Send, TriangleAlert, X } from 'lucide-react';
import { Controller, useForm, useWatch, type FieldError as RhfFieldError, type Path, type Resolver } from 'react-hook-form';
import { toast } from 'sonner';
import type { z } from 'zod';
import { JENIS_JABATAN, STATUS_KEPEGAWAIAN, type StatusKepegawaian } from '@shared/enums';
import {
  createPengajuanRequestSchema,
  KEPEGAWAIAN_FIELDS,
  KEPEGAWAIAN_LABELS,
  pangkatForStatus,
  type CreatePengajuanRequest,
  type KepegawaianField,
  type Pengajuan,
  type Profile,
  type RefResponse,
} from '@shared/profile';
import { DatePicker } from '@/components/date-picker';
import { SectionCard } from '@/components/section-card';
import { EmptyState, ErrorState } from '@/components/states';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { PengajuanStatusBadge, PerubahanList } from '@/features/pengajuan/pengajuan-ui';
import { errorMessage, isApiError } from '@/lib/api';
import { formatDateTimeWITA, formatRelative } from '@/lib/format';
import { formatKepegawaianValue } from './format-values';
import { useCancelPengajuan, useCreatePengajuan, useMyPengajuan } from './queries';
import { enumOptions, SelectControl } from './select-control';

interface KepegawaianCardProps {
  profile: Profile;
  pengajuanAktif: Pengajuan | null;
  refData: RefResponse | undefined;
  id?: string;
  className?: string;
}

/** Read-only employment data; changes go through a pengajuan reviewed by the Administrator TU. */
export function KepegawaianCard({ profile, pengajuanAktif, refData, id, className }: KepegawaianCardProps) {
  return (
    <SectionCard
      id={id}
      className={className}
      title="Kepegawaian"
      description={
        <>
          <Lock className="mr-1 inline size-3.5 align-[-2px]" aria-hidden="true" />
          Diubah melalui pengajuan yang diverifikasi Administrator TU.
        </>
      }
      action={pengajuanAktif ? null : <AjukanPerubahanDialog profile={profile} refData={refData} />}
      wideAction
    >
      <div className="flex flex-col gap-6">
        {pengajuanAktif ? <PengajuanAktifCallout pengajuan={pengajuanAktif} refData={refData} /> : null}
        <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2 xl:grid-cols-3">
          {KEPEGAWAIAN_FIELDS.map((field) => (
            <div key={field} className="flex flex-col gap-1">
              <dt className="text-eyebrow text-muted-foreground uppercase">{KEPEGAWAIAN_LABELS[field]}</dt>
              <dd className="text-sm font-medium break-words text-foreground">{formatKepegawaianValue(field, profile[field], refData)}</dd>
            </div>
          ))}
        </dl>
      </div>
    </SectionCard>
  );
}

/* -------------------------------------------------------------------------- */
/* Pengajuan aktif                                                            */
/* -------------------------------------------------------------------------- */

function PengajuanAktifCallout({ pengajuan, refData }: { pengajuan: Pengajuan; refData: RefResponse | undefined }) {
  const cancel = useCancelPengajuan();
  const [open, setOpen] = useState(false);

  const confirm = (event: React.MouseEvent) => {
    event.preventDefault();
    cancel.mutate(pengajuan.id, {
      onSuccess: () => {
        toast.success('Pengajuan perubahan dibatalkan.');
        setOpen(false);
      },
      onError: (error) => {
        toast.error(errorMessage(error));
        setOpen(false);
      },
    });
  };

  return (
    <div className="flex gap-3 rounded-xl border border-status-pending/25 bg-status-pending-muted p-4 text-sm">
      <FileClock className="mt-0.5 size-4 shrink-0 text-status-pending" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <p className="font-medium text-status-pending">Pengajuan perubahan sedang menunggu verifikasi</p>
          <p className="text-muted-foreground">
            Diajukan {formatRelative(pengajuan.createdAt)} ({formatDateTimeWITA(pengajuan.createdAt)}).
          </p>
        </div>
        <div className="w-full rounded-lg border bg-card p-3">
          <PerubahanList perubahan={pengajuan.perubahan} refData={refData} />
        </div>
        {pengajuan.alasan ? (
          <p className="text-foreground">
            <span className="text-muted-foreground">Alasan: </span>
            {pengajuan.alasan}
          </p>
        ) : null}
        <AlertDialog open={open} onOpenChange={(next) => !cancel.isPending && setOpen(next)}>
          <AlertDialogTrigger asChild>
            <Button size="sm" variant="outline" className="w-fit bg-card">
              <X data-icon="inline-start" />
              Batalkan Pengajuan
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Batalkan pengajuan perubahan?</AlertDialogTitle>
              <AlertDialogDescription>
                Pengajuan ini tidak akan diproses oleh Administrator TU. Anda dapat membuat pengajuan baru setelahnya.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={cancel.isPending}>Kembali</AlertDialogCancel>
              <AlertDialogAction variant="destructive" disabled={cancel.isPending} onClick={confirm}>
                {cancel.isPending ? <Spinner data-icon="inline-start" /> : null}
                Batalkan Pengajuan
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Ajukan perubahan                                                           */
/* -------------------------------------------------------------------------- */

type PengajuanOutput = z.output<typeof createPengajuanRequestSchema>;
interface PengajuanForm {
  pilih: Record<KepegawaianField, boolean>;
  /** All values as strings ('' = empty); converted in buildPayload. */
  perubahan: Record<KepegawaianField, string>;
  alasan: string;
}

const REQUIRED_MESSAGE: Record<KepegawaianField, string> = {
  statusKepegawaian: 'Pilih status kepegawaian.',
  pangkatKode: 'Pilih pangkat/golongan.',
  tmtPangkat: 'Pilih TMT pangkat.',
  jabatan: 'Jabatan wajib diisi.',
  jenisJabatan: 'Pilih jenis jabatan.',
  tmtJabatan: 'Pilih TMT jabatan.',
  unitId: 'Pilih unit organisasi.',
};

const ALASAN_MAX = 500;

function defaultForm(profile: Profile): PengajuanForm {
  const pilih = {} as Record<KepegawaianField, boolean>;
  const perubahan = {} as Record<KepegawaianField, string>;
  for (const field of KEPEGAWAIAN_FIELDS) {
    pilih[field] = false;
    const value = profile[field];
    perubahan[field] = value === null ? '' : String(value);
  }
  return { pilih, perubahan, alasan: '' };
}

function buildPayload(values: PengajuanForm): CreatePengajuanRequest {
  const perubahan: Record<string, string | number> = {};
  for (const field of KEPEGAWAIAN_FIELDS) {
    if (!values.pilih[field]) continue;
    const raw = values.perubahan[field];
    perubahan[field] = field === 'unitId' && raw !== '' ? Number(raw) : raw;
  }
  return { perubahan: perubahan as CreatePengajuanRequest['perubahan'], alasan: values.alasan };
}

const baseResolver = zodResolver(createPengajuanRequestSchema);

/** Validates the built payload with the shared schema; empty selected fields get a friendly message. */
const pengajuanResolver: Resolver<PengajuanForm, unknown, PengajuanOutput> = async (values, context, options) => {
  const result = await baseResolver(buildPayload(values), context, options as never);
  const errors = { ...(result.errors as Record<string, unknown>) };
  const perubahanErrors = { ...((errors.perubahan as Record<string, RhfFieldError> | undefined) ?? {}) };
  let changed = false;
  for (const field of KEPEGAWAIAN_FIELDS) {
    if (values.pilih[field] && values.perubahan[field].trim() === '') {
      perubahanErrors[field] = { type: 'required', message: REQUIRED_MESSAGE[field] };
      changed = true;
    }
  }
  if (changed) errors.perubahan = perubahanErrors;
  if (Object.keys(errors).length === 0) return result as never;
  return { values: {}, errors } as never;
};

function pangkatFamily(status: string | null | undefined): 'PNS' | 'PPPK' | null {
  if (!status) return null;
  return status === 'PPPK' ? 'PPPK' : 'PNS';
}

function AjukanPerubahanDialog({ profile, refData }: { profile: Profile; refData: RefResponse | undefined }) {
  const [open, setOpen] = useState(false);
  const create = useCreatePengajuan();
  const form = useForm<PengajuanForm, unknown, PengajuanOutput>({
    resolver: pengajuanResolver,
    defaultValues: defaultForm(profile),
  });
  const { errors } = form.formState;
  const pilih = useWatch({ control: form.control, name: 'pilih' });
  const statusBaru = useWatch({ control: form.control, name: 'perubahan.statusKepegawaian' });
  const alasan = useWatch({ control: form.control, name: 'alasan' }) ?? '';

  const effectiveStatus = (pilih.statusKepegawaian ? statusBaru : profile.statusKepegawaian) || null;
  const pangkatOptions = pangkatForStatus(refData?.pangkat ?? [], effectiveStatus as StatusKepegawaian | null).map((p) => ({
    value: p.kode,
    label: p.nama,
  }));
  const unitOptions = (refData?.unit ?? []).map((u) => ({ value: String(u.id), label: u.nama }));
  const anySelected = KEPEGAWAIAN_FIELDS.some((field) => pilih[field]);
  const familyChanged =
    pilih.statusKepegawaian && pangkatFamily(statusBaru) !== pangkatFamily(profile.statusKepegawaian) && !!profile.pangkatKode;

  const onOpenChange = (next: boolean) => {
    if (create.isPending) return;
    setOpen(next);
    if (next) form.reset(defaultForm(profile));
  };

  const onStatusChange = (value: string, onChange: (v: string) => void) => {
    const before = pangkatFamily(form.getValues('perubahan.statusKepegawaian') || profile.statusKepegawaian);
    onChange(value);
    if (pangkatFamily(value) !== before) {
      form.setValue('perubahan.pangkatKode', '', { shouldDirty: true });
      // Moving between PNS and PPPK lists: the current pangkat is no longer valid.
      if (profile.pangkatKode && pangkatFamily(value) !== pangkatFamily(profile.statusKepegawaian)) {
        form.setValue('pilih.pangkatKode', true, { shouldDirty: true });
      }
    }
  };

  const onSubmit = form.handleSubmit((values) => {
    create.mutate(values as CreatePengajuanRequest, {
      onSuccess: () => {
        toast.success('Pengajuan perubahan terkirim dan menunggu verifikasi.');
        setOpen(false);
      },
      onError: (error) => {
        if (isApiError(error, 'VALIDATION_ERROR') && error.fields) {
          for (const [key, message] of Object.entries(error.fields)) {
            const [head, sub] = key.split('.');
            if (head === 'perubahan' && sub && (KEPEGAWAIAN_FIELDS as readonly string[]).includes(sub)) {
              form.setError(`perubahan.${sub}` as Path<PengajuanForm>, { message });
            } else if (key === 'alasan') {
              form.setError('alasan', { message });
            } else {
              form.setError('root', { message });
            }
          }
          return;
        }
        if (isApiError(error, 'CONFLICT')) {
          form.setError('root', { message: 'Masih ada pengajuan yang menunggu verifikasi. Muat ulang halaman ini.' });
          return;
        }
        form.setError('root', { message: errorMessage(error) });
      },
    });
  });

  const fieldError = (field: KepegawaianField) => errors.perubahan?.[field];

  const renderInput = (field: KepegawaianField) => {
    const id = `pengajuan-${field}`;
    const invalid = fieldError(field) ? true : undefined;
    const name = `perubahan.${field}` as const;

    switch (field) {
      case 'statusKepegawaian':
        return (
          <Controller
            control={form.control}
            name={name}
            render={({ field: f }) => (
              <SelectControl
                id={id}
                value={f.value}
                onChange={(v) => onStatusChange(v, f.onChange)}
                onBlur={f.onBlur}
                options={enumOptions(STATUS_KEPEGAWAIAN)}
                placeholder="Pilih status"
                invalid={invalid}
              />
            )}
          />
        );
      case 'pangkatKode':
        return (
          <Controller
            control={form.control}
            name={name}
            render={({ field: f }) => (
              <SelectControl
                id={id}
                value={pangkatOptions.some((o) => o.value === f.value) ? f.value : ''}
                onChange={f.onChange}
                onBlur={f.onBlur}
                options={pangkatOptions}
                placeholder={refData ? 'Pilih pangkat/golongan' : 'Memuat…'}
                disabled={!refData}
                invalid={invalid}
              />
            )}
          />
        );
      case 'jenisJabatan':
        return (
          <Controller
            control={form.control}
            name={name}
            render={({ field: f }) => (
              <SelectControl
                id={id}
                value={f.value}
                onChange={f.onChange}
                onBlur={f.onBlur}
                options={enumOptions(JENIS_JABATAN)}
                placeholder="Pilih jenis jabatan"
                invalid={invalid}
              />
            )}
          />
        );
      case 'unitId':
        return (
          <Controller
            control={form.control}
            name={name}
            render={({ field: f }) => (
              <SelectControl
                id={id}
                value={f.value}
                onChange={f.onChange}
                onBlur={f.onBlur}
                options={unitOptions}
                placeholder={refData ? 'Pilih unit organisasi' : 'Memuat…'}
                disabled={!refData}
                invalid={invalid}
              />
            )}
          />
        );
      case 'tmtPangkat':
      case 'tmtJabatan':
        return (
          <Controller
            control={form.control}
            name={name}
            render={({ field: f }) => (
              <DatePicker
                id={id}
                value={f.value}
                onChange={f.onChange}
                onBlur={f.onBlur}
                invalid={invalid}
                fromYear={1970}
                maxDate={new Date(new Date().getFullYear() + 1, 11, 31)}
              />
            )}
          />
        );
      case 'jabatan':
        return <Input id={id} maxLength={150} aria-invalid={invalid} {...form.register(name)} />;
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <Button variant="outline" size="sm" onClick={() => onOpenChange(true)}>
        <Pencil data-icon="inline-start" />
        Ajukan perubahan
      </Button>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Ajukan Perubahan Data Kepegawaian</DialogTitle>
          <DialogDescription>
            Centang data yang ingin diubah lalu isi nilai barunya. Perubahan berlaku setelah disetujui Administrator TU.
          </DialogDescription>
        </DialogHeader>

        <form id="pengajuan-form" noValidate onSubmit={onSubmit}>
          <FieldGroup>
            <FieldSet>
              <FieldLegend variant="label">Data yang diubah</FieldLegend>
              <div className="flex flex-col gap-3">
                {KEPEGAWAIAN_FIELDS.map((field) => {
                  const checkboxId = `pilih-${field}`;
                  const selected = pilih[field];
                  const error = fieldError(field);
                  return (
                    <div
                      key={field}
                      className="flex flex-col gap-3 rounded-lg border p-3 has-data-[state=checked]:border-primary/30 has-data-[state=checked]:bg-accent-soft"
                    >
                      <Field orientation="horizontal">
                        <Controller
                          control={form.control}
                          name={`pilih.${field}`}
                          render={({ field: f }) => (
                            <Checkbox id={checkboxId} checked={f.value} onCheckedChange={(v) => f.onChange(v === true)} />
                          )}
                        />
                        <FieldLabel htmlFor={checkboxId} className="flex-1 font-normal">
                          <span className="font-medium">{KEPEGAWAIAN_LABELS[field]}</span>
                          <span className="ml-auto truncate text-xs text-muted-foreground">
                            Saat ini: {formatKepegawaianValue(field, profile[field], refData)}
                          </span>
                        </FieldLabel>
                      </Field>
                      {selected ? (
                        <Field data-invalid={error ? true : undefined}>
                          <FieldLabel htmlFor={`pengajuan-${field}`} className="sr-only">
                            {KEPEGAWAIAN_LABELS[field]} baru
                          </FieldLabel>
                          {renderInput(field)}
                          {field === 'pangkatKode' && familyChanged ? (
                            <FieldDescription>Status berganti jenis ASN, pilih pangkat/golongan yang sesuai.</FieldDescription>
                          ) : null}
                          <FieldError errors={[error]} />
                        </Field>
                      ) : null}
                    </div>
                  );
                })}
              </div>
              {errors.perubahan?.message ? <FieldError>{errors.perubahan.message}</FieldError> : null}
            </FieldSet>

            <Field data-invalid={errors.alasan ? true : undefined}>
              <FieldLabel htmlFor="pengajuan-alasan">Alasan perubahan</FieldLabel>
              <Textarea
                id="pengajuan-alasan"
                rows={3}
                maxLength={ALASAN_MAX}
                placeholder="Contoh: Kenaikan pangkat sesuai SK Nomor … tanggal …"
                aria-invalid={errors.alasan ? true : undefined}
                aria-describedby="pengajuan-alasan-counter"
                {...form.register('alasan')}
              />
              <FieldDescription id="pengajuan-alasan-counter" className="flex justify-between">
                <span>Minimal 10 karakter. Sebutkan dasar perubahan (mis. nomor SK).</span>
                <span className="tabular-nums">
                  {alasan.length}/{ALASAN_MAX}
                </span>
              </FieldDescription>
              <FieldError errors={[errors.alasan]} />
            </Field>

            {errors.root?.message ? (
              <Alert variant="destructive" role="alert">
                <TriangleAlert />
                <AlertDescription>{errors.root.message}</AlertDescription>
              </Alert>
            ) : null}
          </FieldGroup>
        </form>

        <DialogFooter>
          <Button variant="outline" disabled={create.isPending} onClick={() => onOpenChange(false)}>
            Batal
          </Button>
          <Button type="submit" form="pengajuan-form" disabled={create.isPending || !anySelected}>
            {create.isPending ? <Spinner data-icon="inline-start" /> : <Send data-icon="inline-start" />}
            Kirim Pengajuan
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/* Riwayat                                                                    */
/* -------------------------------------------------------------------------- */

export function RiwayatPengajuanCard({ refData, id, className }: { refData: RefResponse | undefined; id?: string; className?: string }) {
  const query = useMyPengajuan();

  return (
    <SectionCard id={id} className={className} title="Riwayat pengajuan" description="Pengajuan perubahan data kepegawaian yang pernah Anda kirim." flush>
      {query.isPending ? (
        <div className="flex flex-col gap-3 p-5" aria-busy="true" aria-label="Memuat riwayat pengajuan">
          {[0, 1].map((i) => (
            <div key={i} className="flex flex-col gap-2">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-full max-w-md" />
            </div>
          ))}
        </div>
      ) : query.isError ? (
        <ErrorState
          error={query.error}
          title="Gagal memuat riwayat pengajuan"
          size="inline"
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      ) : query.data.items.length === 0 ? (
        <EmptyState icon={History} size="inline" title="Belum ada pengajuan" description="Pengajuan perubahan data kepegawaian Anda akan tampil di sini." />
      ) : (
        <ul className="divide-y">
          {query.data.items.map((item) => (
            <li key={item.id} className="flex flex-col gap-3 px-5 py-4">
              <div className="flex flex-wrap items-center gap-2">
                <PengajuanStatusBadge status={item.status} />
                <span className="text-xs text-muted-foreground" title={formatDateTimeWITA(item.createdAt)}>
                  Diajukan {formatRelative(item.createdAt)}
                </span>
              </div>
              <PerubahanList perubahan={item.perubahan} refData={refData} />
              {item.alasan ? (
                <p className="text-sm text-muted-foreground">
                  <span className="font-medium text-foreground">Alasan:</span> {item.alasan}
                </p>
              ) : null}
              {item.reviewedAt ? (
                <p className="text-sm text-muted-foreground">
                  {item.status === 'Dibatalkan' ? 'Dibatalkan' : `Ditinjau${item.reviewedBy ? ` oleh ${item.reviewedBy.nama}` : ''}`} pada{' '}
                  {formatDateTimeWITA(item.reviewedAt)}
                  {item.catatanAdmin ? (
                    <>
                      <br />
                      <span className="font-medium text-foreground">Catatan admin:</span> {item.catatanAdmin}
                    </>
                  ) : null}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
