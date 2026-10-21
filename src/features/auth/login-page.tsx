import { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { Eye, EyeOff, LogIn } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { useNavigate, useSearchParams } from 'react-router';
import { loginRequestSchema, type LoginRequest } from '@shared/api';

import kantorSamsat from '@/assets/kantor-samsat.webp';
import logoNtt from '@/assets/logo-ntt.webp';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group';
import { Spinner } from '@/components/ui/spinner';
import { useLogin } from '@/features/auth/queries';
import { errorMessage, isApiError } from '@/lib/api';
import { safeNextPath } from '@/lib/safe-next';

const INSTANSI = 'UPTD Pendapatan Daerah Wilayah Kota Kupang';

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
      <aside className="relative hidden overflow-hidden lg:flex lg:w-1/2">
        <img
          src={kantorSamsat}
          alt="Kantor UPTD Pendapatan Daerah Wilayah Kota Kupang"
          width={1600}
          height={809}
          className="absolute inset-0 size-full object-cover"
        />
        <div aria-hidden="true" className="absolute inset-0 bg-linear-to-t from-primary via-primary/80 to-primary/60" />
        <div className="relative flex flex-1 flex-col justify-end gap-6 p-12 text-primary-foreground">
          <img src={logoNtt} alt="" className="size-16 object-contain" />
          <div className="flex flex-col gap-2">
            <p className="text-4xl font-bold tracking-tight">SIKAP</p>
            <p className="text-lg font-medium text-primary-foreground/90">
              Sistem Informasi Kepegawaian dan Arsip Pegawai
            </p>
            <p className="text-sm text-primary-foreground/75">{INSTANSI}</p>
          </div>
        </div>
      </aside>

      <main className="flex flex-1 flex-col items-center justify-center gap-8 px-4 py-10 sm:px-6">
        <Card className="w-full max-w-sm">
          <CardHeader className="gap-1">
            <div className="mb-3 flex items-center gap-3 lg:hidden">
              <img src={logoNtt} alt="" className="size-10 object-contain" />
              <div className="flex flex-col">
                <span className="text-base font-bold tracking-tight text-primary">SIKAP</span>
                <span className="text-xs text-muted-foreground">{INSTANSI}</span>
              </div>
            </div>
            <CardTitle className="text-xl">Masuk ke SIKAP</CardTitle>
            <CardDescription>Gunakan NIP dan password Anda.</CardDescription>
          </CardHeader>
          <CardContent>
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
                    aria-invalid={errors.nip ? true : undefined}
                    {...form.register('nip')}
                  />
                  <FieldError errors={[errors.nip]} />
                </Field>

                <Field data-invalid={errors.password ? true : undefined}>
                  <FieldLabel htmlFor="password">Password</FieldLabel>
                  <InputGroup>
                    <InputGroupInput
                      id="password"
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="current-password"
                      aria-invalid={errors.password ? true : undefined}
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
                </Field>

                {login.error ? (
                  <Alert variant="destructive" role="alert">
                    <AlertDescription>{loginErrorMessage(login.error)}</AlertDescription>
                  </Alert>
                ) : null}

                <Field>
                  <Button type="submit" className="w-full" disabled={login.isPending}>
                    {login.isPending ? (
                      <>
                        <Spinner data-icon="inline-start" />
                        Memproses...
                      </>
                    ) : (
                      <>
                        <LogIn data-icon="inline-start" />
                        Masuk
                      </>
                    )}
                  </Button>
                </Field>
              </FieldGroup>
            </form>
          </CardContent>
        </Card>
        <p className="text-center text-xs text-muted-foreground">
          © {new Date().getFullYear()} {INSTANSI}
        </p>
      </main>
    </div>
  );
}
