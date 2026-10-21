import { ShieldAlert } from 'lucide-react';
import { Link, Navigate, Outlet, useLocation, useSearchParams } from 'react-router';
import type { Role } from '@shared/enums';
import { FullPageLoader } from '@/components/full-page-loader';
import { Button } from '@/components/ui/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { useMe, wasSignedOutIntentionally } from '@/features/auth/queries';
import { safeNextPath } from '@/lib/safe-next';

export function RequireAuth() {
  const { data: user, isPending } = useMe();
  const location = useLocation();

  if (isPending) return <FullPageLoader />;
  if (!user) {
    if (wasSignedOutIntentionally()) return <Navigate to="/login" replace />;
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }
  return <Outlet />;
}

const ROLE_DENIED_MESSAGE: Record<Role, string> = {
  Admin: 'Halaman ini hanya untuk Administrator TU.',
  Pegawai: 'Halaman ini hanya untuk Pegawai.',
};

export function RequireRole({ role }: { role: Role }) {
  const { data: user } = useMe();

  if (user?.role !== role) {
    return (
      <Empty className="min-h-[60vh]">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ShieldAlert />
          </EmptyMedia>
          <EmptyTitle>Akses ditolak</EmptyTitle>
          <EmptyDescription>
            {ROLE_DENIED_MESSAGE[role] ?? 'Anda tidak memiliki akses ke halaman ini.'}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button asChild variant="outline">
            <Link to="/">Kembali ke Beranda</Link>
          </Button>
        </EmptyContent>
      </Empty>
    );
  }
  return <Outlet />;
}

export function RedirectIfAuthed() {
  const { data: user, isPending } = useMe();
  const [searchParams] = useSearchParams();

  if (isPending) return <FullPageLoader />;
  if (user) return <Navigate to={safeNextPath(searchParams.get('next'))} replace />;
  return <Outlet />;
}
