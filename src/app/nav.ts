import type { LucideIcon } from 'lucide-react';
import {
  ClipboardCheck,
  FilePen,
  FileStack,
  FolderOpen,
  LayoutDashboard,
  ScrollText,
  Settings,
  UserRound,
  UserCog,
  Users,
} from 'lucide-react';
import type { Role } from '@shared/enums';

export interface NavItem {
  label: string;
  to: string;
  icon: LucideIcon;
  adminOnly?: boolean;
  /** Live count rendered as a SidebarMenuBadge (resolved in app-shell). */
  badgeKey?: 'pengajuanMenunggu';
}

export interface NavGroup {
  label: string;
  adminOnly?: boolean;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Menu Utama',
    items: [
      { label: 'Beranda', to: '/', icon: LayoutDashboard },
      { label: 'Profil Pegawai', to: '/profil', icon: UserRound },
      { label: 'Arsip Dokumen', to: '/dokumen', icon: FolderOpen },
    ],
  },
  {
    label: 'Administrasi',
    adminOnly: true,
    items: [
      { label: 'Master Data Pegawai', to: '/admin/pegawai', icon: Users },
      { label: 'Verifikasi Dokumen', to: '/admin/verifikasi', icon: ClipboardCheck },
      { label: 'Pengajuan Perubahan', to: '/admin/pengajuan', icon: FilePen, badgeKey: 'pengajuanMenunggu' },
      { label: 'Log Aktivitas', to: '/admin/log', icon: ScrollText },
      { label: 'Jenis Dokumen', to: '/admin/jenis-dokumen', icon: FileStack },
    ],
  },
  {
    label: 'Sistem & Akun',
    items: [
      { label: 'Pengaturan Akun', to: '/akun', icon: UserCog },
      { label: 'Pengaturan Sistem', to: '/admin/pengaturan', icon: Settings, adminOnly: true },
    ],
  },
];

/** Groups and items visible to the given role. */
export function navGroupsForRole(role: Role): NavGroup[] {
  const isAdmin = role === 'Admin';
  return NAV_GROUPS.filter((g) => isAdmin || !g.adminOnly)
    .map((g) => ({ ...g, items: g.items.filter((i) => isAdmin || !i.adminOnly) }))
    .filter((g) => g.items.length > 0);
}

/** Exact match for '/', prefix match (segment-aware) otherwise. */
export function isNavItemActive(to: string, pathname: string): boolean {
  if (to === '/') return pathname === '/';
  return pathname === to || pathname.startsWith(`${to}/`);
}

/** Page title for the breadcrumb; falls back to 'Beranda'. */
export function titleForPath(pathname: string): string {
  let best: NavItem | undefined;
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      if (isNavItemActive(item.to, pathname) && (!best || item.to.length > best.to.length)) best = item;
    }
  }
  return best?.label ?? 'Beranda';
}
