import { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { CircleAlert, Eye, EyeOff, LogIn } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { useNavigate, useSearchParams } from 'react-router';
import { loginRequestSchema, type LoginRequest } from '@shared/api';

import kantorSamsat from '@/assets/kantor-samsat.webp';
import logoNtt from '@/assets/logo-ntt.webp';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group';
import { Spinner } from '@/components/ui/spinner';
import { useLogin } from '@/features/auth/queries';
import { errorMessage, isApiError } from '@/lib/api';
import { APP_FULL_NAME, INSTANSI } from '@/lib/instansi';
import { safeNextPath } from '@/lib/safe-next';

function loginErrorMessage(error: unknown): string {
  if (isApiError(error)) {
    switch (error.code) {
      case 'INVALID_CREDENTIALS':
        return 'NIP atau password salah.';
      case 'ACCOUNT_LOCKED': {
        const minutes = Math.max(1, Math.ceil((error.retryAfterSeconds ?? 60) / 60));
        return `Akun terkunci sementara karena terlalu banyak percobaan gagal. Coba lagi dalam ${minutes} menit.`;
      }
      case 'ACCOUNT_INACTIVE':
        return 'Akun Anda tidak aktif. Hubungi Administrator TU.';
      case 'RATE_LIMITED':
        return 'Terlalu banyak percobaan dari perangkat ini. Coba lagi nanti.';
      default:
        return errorMessage(error);
    }
  }
  return errorMessage(error);
}

export default function LoginPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const login = useLogin();
  const [showPassword, setShowPassword] = useState(false);

  const form = useForm<LoginRequest>({
    resolver: zodResolver(loginRequestSchema),
    defaultValues: { nip: '', password: '' },
  });
  const { errors } = form.formState;

  const onSubmit = form.handleSubmit((values) => {
    login.mutate(values, {
      onSuccess: () => {
        navigate(safeNextPath(searchParams.get('next')), { replace: true });
      },
    });
  });

  return (
    <div className="flex min-h-svh bg-background">
      <aside className="relative hidden overflow-hidden bg-ink lg:flex lg:w-[52%]">
        <img
          src={kantorSamsat}
          alt="Kantor UPTD Pendapatan Daerah Wilayah Kota Kupang"
          width={1600}
          height={809}
          className="absolute inset-0 size-full object-cover opacity-90"
        />
        {/* Ink overlay (not a brand gradient): keeps the photo, guarantees contrast for the white text. */}
        <div aria-hidden="true" className="absolute inset-0 bg-linear-to-t from-ink via-ink/75 to-ink/25" />
        <div className="relative flex flex-1 flex-col justify-between p-12 text-white">
          <img src={logoNtt} alt="" className="size-14 object-contain" />
          <div className="flex max-w-lg flex-col gap-3">
            <p className="text-eyebrow text-white/70 uppercase">{INSTANSI}</p>
            <p className="text-5xl font-semibold tracking-tight">SIKAP</p>
            <p className="text-lg text-white/85">{APP_FULL_NAME}</p>
          </div>
        </div>
      </aside>

      <main className="flex flex-1 flex-col items-center justify-center gap-8 px-4 py-10 sm:px-6">
        <div className="flex w-full max-w-sm flex-col gap-6">
          <div className="flex flex-col items-center gap-3 text-center lg:hidden">
            <img src={logoNtt} alt="" className="size-14 object-contain" />
            <div className="flex flex-col gap-0.5">
              <p className="text-h2 text-primary">SIKAP</p>
              <p className="text-xs text-muted-foreground">{INSTANSI}</p>
            </div>
          </div>

          <div className="rounded-2xl border bg-card p-6 shadow-pop sm:p-8">
            <div className="mb-6 flex flex-col gap-1">
              <h1 className="text-h2 text-foreground">Masuk ke SIKAP</h1>
              <p className="text-sm text-muted-foreground">Gunakan NIP dan password Anda.</p>
            </div>

            <form noValidate onSubmit={onSubmit}>
              <FieldGroup>
                <Field data-invalid={errors.nip ? true : undefined}>
                  <FieldLabel htmlFor="nip">NIP</FieldLabel>
                  <Input
                    id="nip"
                    inputMode="numeric"
                    autoComplete="username"
                    maxLength={18}
                    autoFocus
                    placeholder="18 digit NIP"
                    className="h-10 tabular-nums"
                    aria-invalid={errors.nip ? true : undefined}
                    {...form.register('nip')}
                  />
                  <FieldError errors={[errors.nip]} />
                </Field>

                <Field data-invalid={errors.password ? true : undefined}>
                  <FieldLabel htmlFor="password">Password</FieldLabel>
                  <InputGroup className="h-10">
                    <InputGroupInput
                      id="password"
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="current-password"
                      aria-invalid={errors.password ? true : undefined}
                      aria-describedby="password-help"
                      {...form.register('password')}
                    />
                    <InputGroupAddon align="inline-end">
                      <InputGroupButton
                        size="icon-xs"
                        aria-label={showPassword ? 'Sembunyikan password' : 'Tampilkan password'}
                        aria-pressed={showPassword}
                        onClick={() => setShowPassword((v) => !v)}
                      >
                        {showPassword ? <EyeOff /> : <Eye />}
                      </InputGroupButton>
                    </InputGroupAddon>
                  </InputGroup>
                  <FieldError errors={[errors.password]} />
                  <FieldDescription id="password-help">Lupa password? Hubungi Administrator TU untuk mengatur ulang.</FieldDescription>
                </Field>

                {login.error ? (
                  <p role="alert" className="flex gap-2 rounded-lg border border-status-rejected/25 bg-status-rejected-muted px-3 py-2.5 text-sm text-status-rejected">
                    <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                    {loginErrorMessage(login.error)}
                  </p>
                ) : null}

                <Button type="submit" size="lg" className="w-full" disabled={login.isPending}>
                  {login.isPending ? <Spinner data-icon="inline-start" /> : <LogIn data-icon="inline-start" />}
                  {login.isPending ? 'Memproses…' : 'Masuk'}
                </Button>
              </FieldGroup>
            </form>
          </div>
        </div>
        <p className="text-center text-xs text-muted-foreground">
          © {new Date().getFullYear()} {INSTANSI}
        </p>
      </main>
    </div>
  );
}
