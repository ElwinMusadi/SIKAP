import { ClipboardCheck, FolderOpen, LayoutDashboard, Menu, UserCog, UserRound, Users, type LucideIcon } from 'lucide-react';
import { NavLink, useLocation } from 'react-router';
import type { SessionUser } from '@shared/api';
import { isNavItemActive } from '@/app/nav';
import { formatBadge, type ShellCounts } from '@/app/use-shell-counts';
import { useSidebar } from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';

interface MobileItem {
  to: string;
  label: string;
  icon: LucideIcon;
  badge?: number;
}

function itemsFor(user: SessionUser, counts: ShellCounts): MobileItem[] {
  if (user.role === 'Admin') {
    return [
      { to: '/', label: 'Beranda', icon: LayoutDashboard },
      { to: '/admin/verifikasi', label: 'Verifikasi', icon: ClipboardCheck, badge: counts.verifikasiMenunggu },
      { to: '/admin/pegawai', label: 'Pegawai', icon: Users },
      { to: '/dokumen', label: 'Dokumen', icon: FolderOpen },
    ];
  }
  return [
    { to: '/', label: 'Beranda', icon: LayoutDashboard },
    { to: '/dokumen', label: 'Dokumen', icon: FolderOpen },
    { to: '/profil', label: 'Profil', icon: UserRound },
    { to: '/akun', label: 'Akun', icon: UserCog },
  ];
}

const itemClass =
  'relative flex min-h-14 flex-1 flex-col items-center justify-center gap-1 rounded-lg text-[11px] font-medium text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring';

/** Bottom navigation for phones (Blueprint UI requirement); admins reach the rest via "Lainnya". */
export function MobileNav({ user, counts }: { user: SessionUser; counts: ShellCounts }) {
  const { pathname } = useLocation();
  const { setOpenMobile } = useSidebar();
  const items = itemsFor(user, counts);
  const isAdmin = user.role === 'Admin';

  return (
    <nav
      aria-label="Navigasi utama"
      className="fixed inset-x-0 bottom-0 z-20 border-t bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur supports-[backdrop-filter]:bg-card/85 md:hidden"
    >
      <ul className="mx-auto flex max-w-lg items-stretch gap-1 px-2 py-1">
        {items.map((item) => {
          const active = isNavItemActive(item.to, pathname);
          return (
            <li key={item.to} className="flex flex-1">
              <NavLink
                to={item.to}
                end={item.to === '/'}
                className={cn(itemClass, active && 'text-primary')}
                aria-current={active ? 'page' : undefined}
              >
                <span className={cn('flex h-7 w-12 items-center justify-center rounded-full transition-colors', active && 'bg-accent-soft')}>
                  <item.icon className="size-5" aria-hidden="true" />
                </span>
                {item.label}
                {item.badge ? (
                  <>
                    <span
                      aria-hidden="true"
                      className="absolute top-1 left-1/2 ml-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-status-pending px-1 text-[10px] leading-none font-semibold text-white tabular-nums dark:text-black"
                    >
                      {formatBadge(item.badge)}
                    </span>
                    <span className="sr-only">({item.badge} menunggu)</span>
                  </>
                ) : null}
              </NavLink>
            </li>
          );
        })}
        {isAdmin ? (
          <li className="flex flex-1">
            <button type="button" className={itemClass} onClick={() => setOpenMobile(true)}>
              <span className="flex h-7 w-12 items-center justify-center rounded-full">
                <Menu className="size-5" aria-hidden="true" />
              </span>
              Lainnya
            </button>
          </li>
        ) : null}
      </ul>
    </nav>
  );
}
