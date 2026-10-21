import type { SessionUser } from '@shared/api';
import type { NavItem } from '@/app/nav';
import { useAdminPengajuan } from '@/features/profil/queries';
import { useVerifikasiCount } from '@/features/verifikasi/queries';

export type ShellCounts = Record<NonNullable<NavItem['badgeKey']>, number>;

/** Live work-queue counts shared by the sidebar badges, the tasks menu and the mobile nav (React Query dedupes). */
export function useShellCounts(user: SessionUser): ShellCounts {
  const isAdmin = user.role === 'Admin';
  const pengajuanQuery = useAdminPengajuan('Menunggu', isAdmin);
  const verifikasiQuery = useVerifikasiCount(isAdmin);
  return {
    pengajuanMenunggu: pengajuanQuery.data?.counts.Menunggu ?? 0,
    verifikasiMenunggu: verifikasiQuery.data ?? 0,
  };
}

export function formatBadge(count: number): string {
  return count > 99 ? '99+' : String(count);
}
