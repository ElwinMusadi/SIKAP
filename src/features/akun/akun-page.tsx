import { useMemo, useState, type ComponentProps } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { CircleCheck, CircleX, Eye, EyeOff, KeyRound, LogOut, Monitor, MonitorSmartphone, Moon, Smartphone, Sun, TriangleAlert } from 'lucide-react';
import { useForm, useWatch } from 'react-hook-form';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import type { z } from 'zod';
import {
  changePasswordRequestSchema,
  type ChangePasswordRequest,
  type SessionInfo,
  type SessionUser,
} from '@shared/api';
import { defaultPasswordFor, PASSWORD_RULES } from '@shared/validators';

import { useTheme, type ThemePreference } from '@/app/theme';
import { PageHeader } from '@/components/page-header';
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
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { useChangePassword, useMe, useRevokeOtherSessions, useRevokeSession, useSessions } from '@/features/auth/queries';
import { errorMessage, isApiError } from '@/lib/api';
import { formatDateTimeWITA, formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';
import { describeUserAgent } from './user-agent';

const SECTIONS = [
  { id: 'keamanan', label: 'Keamanan' },
  { id: 'sesi', label: 'Sesi aktif' },
  { id: 'tampilan', label: 'Tampilan' },
  { id: 'informasi', label: 'Informasi akun' },
] as const;

export default function AkunPage() {
  const { data: user } = useMe();
  if (!user) return null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Pengaturan Akun" description="Kelola password, perangkat yang masuk, dan tampilan aplikasi." />
      <div className="grid items-start gap-6 lg:grid-cols-[12rem_minmax(0,1fr)]">
        <nav aria-label="Bagian pengaturan" className="hidden flex-col gap-0.5 lg:sticky lg:top-20 lg:flex">
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
        <div className="flex max-w-3xl min-w-0 flex-col gap-6">
          <ChangePasswordCard user={user} />
          <SessionsCard />
          <ThemeCard />
          <AccountInfoCard user={user} />
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Ganti password                                                             */
/* -------------------------------------------------------------------------- */

type ChangePasswordSchema = ReturnType<typeof changePasswordRequestSchema>;
type ChangePasswordOutput = z.output<ChangePasswordSchema>;
type ChangePasswordField = 'currentPassword' | 'newPassword' | 'confirmPassword';

const CHANGE_PASSWORD_FIELDS: readonly ChangePasswordField[] = ['currentPassword', 'newPassword', 'confirmPassword'];

const DEFAULT_VALUES: ChangePasswordRequest = {
  currentPassword: '',
  newPassword: '',
  confirmPassword: '',
  revokeOtherSessions: true,
};

function isFormField(key: string): key is ChangePasswordField {
  return (CHANGE_PASSWORD_FIELDS as readonly string[]).includes(key);
}

interface PasswordFieldProps {
  id: ChangePasswordField;
  label: string;
  autoComplete: 'current-password' | 'new-password';
  error?: { message?: string };
  inputProps: ComponentProps<typeof InputGroupInput>;
  children?: React.ReactNode;
}

function PasswordField({ id, label, autoComplete, error, inputProps, children }: PasswordFieldProps) {
  const [visible, setVisible] = useState(false);
  const invalid = error ? true : undefined;

  return (
    <Field data-invalid={invalid}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <InputGroup>
        <InputGroupInput id={id} type={visible ? 'text' : 'password'} autoComplete={autoComplete} aria-invalid={invalid} {...inputProps} />
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            size="icon-xs"
            aria-label={visible ? 'Sembunyikan password' : 'Tampilkan password'}
            aria-pressed={visible}
            onClick={() => setVisible((v) => !v)}
          >
            {visible ? <EyeOff /> : <Eye />}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      {children}
      <FieldError errors={[error]} />
    </Field>
  );
}

/** Rule checklist with a segmented meter (one segment per rule; amber while incomplete, green when all pass). */
function PasswordChecklist({ value, nip }: { value: string; nip: string }) {
  const rules = [
    ...PASSWORD_RULES.map((rule) => ({ id: rule.id, label: rule.label, passed: rule.test(value) })),
    { id: 'not-default', label: 'Berbeda dari password default', passed: value.length > 0 && value !== defaultPasswordFor(nip) },
  ];
  const passedCount = rules.filter((rule) => rule.passed).length;
  const complete = passedCount === rules.length;

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-3" aria-hidden="true">
        <div className="flex flex-1 gap-1">
          {rules.map((rule, index) => (
            <span
              key={rule.id}
              className={cn(
                'h-1.5 flex-1 rounded-full transition-colors motion-reduce:transition-none',
                index < passedCount ? (complete ? 'bg-status-verified' : 'bg-status-pending') : 'bg-muted',
              )}
            />
          ))}
        </div>
        <span className={cn('text-xs tabular-nums', complete ? 'font-medium text-status-verified' : 'text-muted-foreground')}>
          {value.length === 0 ? '' : complete ? 'Memenuhi syarat' : `${passedCount}/${rules.length} syarat`}
        </span>
      </div>
      {/* Visible list is static for assistive tech; only the count summary is announced. */}
      <ul aria-label="Syarat password baru" className="grid gap-1 text-sm sm:grid-cols-2">
        {rules.map((rule) => (
          <li key={rule.id} className="flex items-center gap-2">
            {rule.passed ? (
              <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-status-verified" />
            ) : (
              <CircleX aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            )}
            <span className={rule.passed ? 'text-foreground' : 'text-muted-foreground'}>
              {rule.label}
              <span className="sr-only">{rule.passed ? ' (terpenuhi)' : ' (belum terpenuhi)'}</span>
            </span>
          </li>
        ))}
      </ul>
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {value.length > 0 ? `${passedCount} dari ${rules.length} syarat password terpenuhi` : ''}
      </p>
    </div>
  );
}

function ChangePasswordCard({ user }: { user: SessionUser }) {
  const changePassword = useChangePassword();
  const navigate = useNavigate();
  const schema = useMemo(() => changePasswordRequestSchema(user.nip), [user.nip]);

  const form = useForm<ChangePasswordRequest, unknown, ChangePasswordOutput>({
    resolver: zodResolver(schema),
    defaultValues: DEFAULT_VALUES,
  });
  const { errors } = form.formState;
  const newPassword = useWatch({ control: form.control, name: 'newPassword' }) ?? '';

  const onSubmit = form.handleSubmit((values) => {
    // Owner rule (MIGRATION_PLAN §3.1 rule 3): a password change always signs out other devices.
    changePassword.mutate(
      { ...values, revokeOtherSessions: true },
      {
        onSuccess: (data) => {
          const n = data.revokedSessions;
          toast.success(n > 0 ? `Password berhasil diubah. ${n} sesi lain telah dikeluarkan.` : 'Password berhasil diubah.');
          form.reset(DEFAULT_VALUES);
        },
        onError: (error) => {
          if (isApiError(error, 'VALIDATION_ERROR') && error.fields) {
            for (const [key, message] of Object.entries(error.fields)) {
              form.setError(isFormField(key) ? key : 'root', { message });
            }
            return;
          }
          if (isApiError(error, 'ACCOUNT_LOCKED')) {
            // useChangePassword already cleared the cache (server revoked every session).
            toast.error('Terlalu banyak percobaan password salah. Akun dikunci sementara dan Anda telah dikeluarkan.');
            void navigate('/login', { replace: true });
            return;
          }
          form.setError('root', { message: errorMessage(error) });
        },
      },
    );
  });

  return (
    <SectionCard id="keamanan" className="scroll-mt-20" title="Ganti password" description="Gunakan password yang kuat dan tidak dipakai di layanan lain.">
      <div className="flex flex-col gap-6">
        {user.isDefaultPassword ? (
          <div className="flex gap-2.5 rounded-lg border border-status-pending/25 bg-status-pending-muted p-3 text-sm">
            <KeyRound className="mt-0.5 size-4 shrink-0 text-status-pending" aria-hidden="true" />
            <p>
              <span className="font-medium text-status-pending">Anda masih memakai password default.</span>{' '}
              <span className="text-foreground">Password ini mudah ditebak (6 digit terakhir NIP); segera ganti.</span>
            </p>
          </div>
        ) : null}

        <form noValidate onSubmit={onSubmit}>
          <FieldGroup className="max-w-lg">
            <PasswordField
              id="currentPassword"
              label="Password saat ini"
              autoComplete="current-password"
              error={errors.currentPassword}
              inputProps={form.register('currentPassword')}
            />
            <PasswordField id="newPassword" label="Password baru" autoComplete="new-password" error={errors.newPassword} inputProps={form.register('newPassword')}>
              <PasswordChecklist value={newPassword} nip={user.nip} />
            </PasswordField>
            <PasswordField
              id="confirmPassword"
              label="Konfirmasi password baru"
              autoComplete="new-password"
              error={errors.confirmPassword}
              inputProps={form.register('confirmPassword')}
            />

            <FieldDescription>Setelah password diganti, semua perangkat lain akan dikeluarkan otomatis.</FieldDescription>

            {errors.root?.message ? (
              <p role="alert" className="flex items-center gap-2 text-sm text-destructive">
                <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
                {errors.root.message}
              </p>
            ) : null}

            <Field orientation="horizontal">
              <Button type="submit" disabled={changePassword.isPending}>
                {changePassword.isPending ? <Spinner data-icon="inline-start" /> : <KeyRound data-icon="inline-start" />}
                {changePassword.isPending ? 'Menyimpan…' : 'Ganti password'}
              </Button>
            </Field>
          </FieldGroup>
        </form>
      </div>
    </SectionCard>
  );
}

/* -------------------------------------------------------------------------- */
/* Sesi aktif                                                                 */
/* -------------------------------------------------------------------------- */

function sortSessions(sessions: SessionInfo[]): SessionInfo[] {
  return [...sessions].sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    return new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime();
  });
}

function SessionRow({ session }: { session: SessionInfo }) {
  const revoke = useRevokeSession();
  const [open, setOpen] = useState(false);
  const device = describeUserAgent(session.userAgent);
  const DeviceIcon = device.isMobile ? Smartphone : Monitor;

  const confirm = (event: React.MouseEvent) => {
    event.preventDefault();
    revoke.mutate(session.id, {
      onSuccess: () => {
        toast.success('Sesi telah dikeluarkan.');
        setOpen(false);
      },
      onError: (error) => {
        toast.error(errorMessage(error));
        setOpen(false);
      },
    });
  };

  return (
    <li className="flex items-center gap-3 px-5 py-3.5">
      <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-lg', session.current ? 'bg-accent-soft text-primary' : 'bg-muted text-muted-foreground')}>
        <DeviceIcon className="size-4" aria-hidden="true" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
          {device.label}
          {session.current ? <Badge variant="secondary">Perangkat ini</Badge> : null}
        </p>
        <p className="text-xs text-muted-foreground" title={formatDateTimeWITA(session.lastSeenAt)}>
          IP {session.ip ?? 'tidak diketahui'} · aktif {formatRelative(session.lastSeenAt)}
        </p>
      </div>
      {session.current ? null : (
        <AlertDialog open={open} onOpenChange={(next) => !revoke.isPending && setOpen(next)}>
          <AlertDialogTrigger asChild>
            <Button variant="ghost" size="sm">
              Keluarkan
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Keluarkan perangkat ini?</AlertDialogTitle>
              <AlertDialogDescription>
                {device.label} akan dikeluarkan dari akun Anda dan harus masuk kembali untuk mengakses SIKAP.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={revoke.isPending}>Batal</AlertDialogCancel>
              <AlertDialogAction variant="destructive" disabled={revoke.isPending} onClick={confirm}>
                {revoke.isPending ? <Spinner data-icon="inline-start" /> : null}
                Keluarkan
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </li>
  );
}

function RevokeOthersButton({ disabled }: { disabled: boolean }) {
  const revokeOthers = useRevokeOtherSessions();
  const [open, setOpen] = useState(false);

  const confirm = (event: React.MouseEvent) => {
    event.preventDefault();
    revokeOthers.mutate(undefined, {
      onSuccess: (data) => {
        toast.success(data.revoked > 0 ? `${data.revoked} perangkat lain telah dikeluarkan.` : 'Tidak ada perangkat lain yang perlu dikeluarkan.');
        setOpen(false);
      },
      onError: (error) => {
        toast.error(errorMessage(error));
        setOpen(false);
      },
    });
  };

  return (
    <AlertDialog open={open} onOpenChange={(next) => !revokeOthers.isPending && setOpen(next)}>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={disabled}>
          <LogOut data-icon="inline-start" />
          Keluarkan semua
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Keluarkan semua perangkat lain?</AlertDialogTitle>
          <AlertDialogDescription>Semua perangkat selain perangkat ini akan dikeluarkan dari akun Anda dan harus masuk kembali.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={revokeOthers.isPending}>Batal</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={revokeOthers.isPending} onClick={confirm}>
            {revokeOthers.isPending ? <Spinner data-icon="inline-start" /> : null}
            Keluarkan semua
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function SessionsCard() {
  const sessionsQuery = useSessions();
  const sessions = useMemo(() => sortSessions(sessionsQuery.data ?? []), [sessionsQuery.data]);
  const hasOthers = sessions.some((s) => !s.current);

  return (
    <SectionCard
      id="sesi"
      className="scroll-mt-20"
      title="Sesi aktif"
      description="Perangkat yang sedang masuk ke akun Anda."
      action={<RevokeOthersButton disabled={!hasOthers || sessionsQuery.isPending} />}
      wideAction
      flush
    >
      {sessionsQuery.isPending ? (
        <div className="flex flex-col gap-3 p-5" aria-busy="true" aria-label="Memuat sesi">
          {[0, 1].map((i) => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton className="size-9 rounded-lg" />
              <div className="flex flex-1 flex-col gap-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-56" />
              </div>
            </div>
          ))}
        </div>
      ) : sessionsQuery.isError ? (
        <ErrorState error={sessionsQuery.error} title="Gagal memuat sesi aktif" size="inline" onRetry={() => void sessionsQuery.refetch()} retrying={sessionsQuery.isFetching} />
      ) : (
        <>
          <ul className="divide-y">
            {sessions.map((session) => (
              <SessionRow key={session.id} session={session} />
            ))}
          </ul>
          {!hasOthers ? <p className="border-t px-5 py-3 text-sm text-muted-foreground">Tidak ada perangkat lain yang masuk.</p> : null}
        </>
      )}
    </SectionCard>
  );
}

/* -------------------------------------------------------------------------- */
/* Tampilan                                                                   */
/* -------------------------------------------------------------------------- */

const THEME_OPTIONS: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Terang', icon: Sun },
  { value: 'dark', label: 'Gelap', icon: Moon },
  { value: 'system', label: 'Ikuti perangkat', icon: MonitorSmartphone },
];

/** Miniature of each theme (fixed colours on purpose: it depicts the theme, not the current one). */
function ThemeSwatch({ value }: { value: ThemePreference }) {
  const light = (
    <div className="flex flex-1 flex-col gap-1 bg-[#f7f6f2] p-2">
      <span className="h-1.5 w-8 rounded-full bg-[#1e3a8a]" />
      <span className="h-5 rounded bg-white shadow-xs" />
      <span className="h-1.5 w-10 rounded-full bg-[#d9d7cf]" />
    </div>
  );
  const dark = (
    <div className="flex flex-1 flex-col gap-1 bg-[#0d0e11] p-2">
      <span className="h-1.5 w-8 rounded-full bg-[#8ea2ec]" />
      <span className="h-5 rounded bg-[#17181c]" />
      <span className="h-1.5 w-10 rounded-full bg-[#2a2c32]" />
    </div>
  );
  return (
    <div aria-hidden="true" className="flex h-16 overflow-hidden rounded-lg border">
      {value === 'dark' ? dark : light}
      {value === 'system' ? dark : null}
    </div>
  );
}

function ThemeCard() {
  const { preference, setPreference } = useTheme();
  return (
    <SectionCard id="tampilan" className="scroll-mt-20" title="Tampilan" description="Berlaku untuk perangkat dan browser ini saja.">
      <RadioGroup
        value={preference}
        onValueChange={(value) => setPreference(value as ThemePreference)}
        aria-label="Tema"
        className="grid gap-3 sm:grid-cols-3"
      >
        {THEME_OPTIONS.map((option) => (
          <Label
            key={option.value}
            htmlFor={`tema-${option.value}`}
            className="flex cursor-pointer flex-col items-stretch gap-3 rounded-xl border bg-card p-3 font-normal transition-colors hover:bg-muted/50 has-data-[state=checked]:border-primary has-data-[state=checked]:bg-accent-soft motion-reduce:transition-none"
          >
            <ThemeSwatch value={option.value} />
            <span className="flex items-center gap-2 text-sm">
              <RadioGroupItem id={`tema-${option.value}`} value={option.value} />
              <option.icon className="size-4 text-muted-foreground" aria-hidden="true" />
              {option.label}
            </span>
          </Label>
        ))}
      </RadioGroup>
    </SectionCard>
  );
}

/* -------------------------------------------------------------------------- */
/* Informasi akun                                                             */
/* -------------------------------------------------------------------------- */

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-eyebrow text-muted-foreground uppercase">{label}</dt>
      <dd className="text-sm font-medium break-words text-foreground">{children}</dd>
    </div>
  );
}

function AccountInfoCard({ user }: { user: SessionUser }) {
  return (
    <SectionCard id="informasi" className="scroll-mt-20" title="Informasi akun" description="Data akun yang sedang digunakan. Perubahan data dilakukan di halaman Profil.">
      <dl className="grid gap-4 sm:grid-cols-2">
        <InfoRow label="NIP">
          <span className="tabular-nums">{user.nip}</span>
        </InfoRow>
        <InfoRow label="Nama">{user.nama}</InfoRow>
        <InfoRow label="Peran">{user.role === 'Admin' ? 'Administrator TU' : 'Pegawai'}</InfoRow>
        <InfoRow label="Status kepegawaian">{user.statusKepegawaian ?? '—'}</InfoRow>
        <InfoRow label="Jabatan">{user.jabatan ?? '—'}</InfoRow>
        <InfoRow label="Password">
          {user.isDefaultPassword ? (
            <Badge variant="outline" className="border-status-pending/25 bg-status-pending-muted text-status-pending">
              Masih default
            </Badge>
          ) : (
            <Badge variant="outline" className="border-status-verified/25 bg-status-verified-muted text-status-verified">
              Sudah diganti
            </Badge>
          )}
        </InfoRow>
      </dl>
    </SectionCard>
  );
}
