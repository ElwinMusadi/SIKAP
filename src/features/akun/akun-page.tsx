import { useMemo, useState, type ComponentProps } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { CircleCheck, CircleX, Eye, EyeOff, KeyRound, LogOut, Monitor, Smartphone } from 'lucide-react';
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

import { PageHeader } from '@/components/page-header';
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
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group';
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { useChangePassword, useMe, useRevokeOtherSessions, useRevokeSession, useSessions } from '@/features/auth/queries';
import { errorMessage, isApiError } from '@/lib/api';
import { formatDateTimeWITA, formatRelative } from '@/lib/format';
import { describeUserAgent } from './user-agent';

export default function AkunPage() {
  const { data: user } = useMe();
  if (!user) return null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Pengaturan Akun" description="Kelola password dan sesi login Anda." />
      <div className="grid items-start gap-6 lg:grid-cols-5">
        <ChangePasswordCard user={user} className="lg:col-span-3" />
        <AccountInfoCard user={user} className="lg:col-span-2" />
        <SessionsCard className="lg:col-span-full" />
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
        <InputGroupInput
          id={id}
          type={visible ? 'text' : 'password'}
          autoComplete={autoComplete}
          aria-invalid={invalid}
          {...inputProps}
        />
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

function PasswordChecklist({ value, nip }: { value: string; nip: string }) {
  const rules = [
    ...PASSWORD_RULES.map((rule) => ({ id: rule.id, label: rule.label, passed: rule.test(value) })),
    { id: 'not-default', label: 'Berbeda dari password default', passed: value.length > 0 && value !== defaultPasswordFor(nip) },
  ];

  const passedCount = rules.filter((rule) => rule.passed).length;

  return (
    <>
      {/* Visible list is static for assistive tech; only the count summary is announced. */}
      <ul aria-label="Syarat password baru" className="flex flex-col gap-1 text-sm">
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
    </>
  );
}

function ChangePasswordCard({ user, className }: { user: SessionUser; className?: string }) {
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
    changePassword.mutate({ ...values, revokeOtherSessions: true }, {
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
    });
  });

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>Ganti Password</CardTitle>
        <CardDescription>Gunakan password yang kuat dan tidak dipakai di layanan lain.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {user.isDefaultPassword ? (
          <Alert>
            <KeyRound />
            <AlertTitle>Anda masih menggunakan password default.</AlertTitle>
            <AlertDescription>Segera ganti password untuk menjaga keamanan akun Anda.</AlertDescription>
          </Alert>
        ) : null}

        <form noValidate onSubmit={onSubmit}>
          <FieldGroup>
            <PasswordField
              id="currentPassword"
              label="Password saat ini"
              autoComplete="current-password"
              error={errors.currentPassword}
              inputProps={form.register('currentPassword')}
            />
            <PasswordField
              id="newPassword"
              label="Password baru"
              autoComplete="new-password"
              error={errors.newPassword}
              inputProps={form.register('newPassword')}
            >
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
              <Alert variant="destructive" role="alert">
                <AlertDescription>{errors.root.message}</AlertDescription>
              </Alert>
            ) : null}

            <Field orientation="horizontal" className="justify-end">
              <Button type="submit" disabled={changePassword.isPending}>
                {changePassword.isPending ? (
                  <>
                    <Spinner data-icon="inline-start" />
                    Menyimpan...
                  </>
                ) : (
                  <>
                    <KeyRound data-icon="inline-start" />
                    Ganti password
                  </>
                )}
              </Button>
            </Field>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Informasi akun                                                             */
/* -------------------------------------------------------------------------- */

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium break-words text-foreground">{children}</dd>
    </div>
  );
}

function AccountInfoCard({ user, className }: { user: SessionUser; className?: string }) {
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>Informasi Akun</CardTitle>
        <CardDescription>Data akun yang sedang digunakan.</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
          <InfoRow label="NIP">
            <span className="font-mono tabular-nums">{user.nip}</span>
          </InfoRow>
          <InfoRow label="Nama">{user.nama}</InfoRow>
          <InfoRow label="Peran">{user.role === 'Admin' ? 'Administrator TU' : 'Pegawai'}</InfoRow>
          <InfoRow label="Status Kepegawaian">{user.statusKepegawaian ?? '—'}</InfoRow>
          <InfoRow label="Jabatan">{user.jabatan ?? '—'}</InfoRow>
          <InfoRow label="Status Password">
            {user.isDefaultPassword ? (
              <Badge variant="outline" className="border-transparent bg-status-pending-muted text-status-pending">
                Default
              </Badge>
            ) : (
              <Badge variant="outline" className="border-transparent bg-status-verified-muted text-status-verified">
                Sudah diganti
              </Badge>
            )}
          </InfoRow>
        </dl>
      </CardContent>
    </Card>
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
    <Item variant="outline">
      <ItemMedia variant="icon">
        <DeviceIcon />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>
          {device.label}
          {session.current ? <Badge variant="secondary">Perangkat ini</Badge> : null}
        </ItemTitle>
        <ItemDescription title={`${formatDateTimeWITA(session.lastSeenAt)} WITA`}>
          IP {session.ip ?? 'tidak diketahui'} · Aktif {formatRelative(session.lastSeenAt)}
        </ItemDescription>
      </ItemContent>
      {session.current ? null : (
        <ItemActions>
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
        </ItemActions>
      )}
    </Item>
  );
}

function RevokeOthersButton({ disabled }: { disabled: boolean }) {
  const revokeOthers = useRevokeOtherSessions();
  const [open, setOpen] = useState(false);

  const confirm = (event: React.MouseEvent) => {
    event.preventDefault();
    revokeOthers.mutate(undefined, {
      onSuccess: (data) => {
        toast.success(
          data.revoked > 0 ? `${data.revoked} perangkat lain telah dikeluarkan.` : 'Tidak ada perangkat lain yang perlu dikeluarkan.',
        );
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
        <Button variant="outline" disabled={disabled}>
          <LogOut data-icon="inline-start" />
          Keluarkan semua perangkat lain
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Keluarkan semua perangkat lain?</AlertDialogTitle>
          <AlertDialogDescription>
            Semua perangkat selain perangkat ini akan dikeluarkan dari akun Anda dan harus masuk kembali.
          </AlertDialogDescription>
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

function SessionsCard({ className }: { className?: string }) {
  const sessionsQuery = useSessions();
  const sessions = useMemo(() => sortSessions(sessionsQuery.data ?? []), [sessionsQuery.data]);
  const hasOthers = sessions.some((s) => !s.current);

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>Sesi Aktif</CardTitle>
        <CardDescription>Perangkat yang sedang masuk ke akun Anda.</CardDescription>
        <CardAction>
          <RevokeOthersButton disabled={!hasOthers || sessionsQuery.isPending} />
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {sessionsQuery.isPending ? (
          <div className="flex flex-col gap-3" aria-busy="true" aria-label="Memuat sesi">
            {[0, 1].map((i) => (
              <div key={i} className="flex items-center gap-3 rounded-lg border p-3">
                <Skeleton className="size-8 rounded-md" />
                <div className="flex flex-1 flex-col gap-2">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-3 w-56" />
                </div>
              </div>
            ))}
          </div>
        ) : sessionsQuery.isError ? (
          <Alert variant="destructive" role="alert">
            <AlertTitle>Gagal memuat sesi aktif.</AlertTitle>
            <AlertDescription>{errorMessage(sessionsQuery.error)}</AlertDescription>
          </Alert>
        ) : (
          <>
            <ItemGroup className="gap-3">
              {sessions.map((session) => (
                <SessionRow key={session.id} session={session} />
              ))}
            </ItemGroup>
            {!hasOthers ? <p className="text-sm text-muted-foreground">Tidak ada perangkat lain yang masuk.</p> : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
