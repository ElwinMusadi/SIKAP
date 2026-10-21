import { useState, type MouseEvent, type ReactNode } from 'react';
import { ChevronsUpDown, KeyRound, LogOut, Monitor, Moon, Search, Settings, Sun, UserRound, X } from 'lucide-react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { toast } from 'sonner';
import type { SessionUser } from '@shared/api';
import logoNtt from '@/assets/logo-ntt.webp';
import { CommandMenu, useCommandMenuHotkey } from '@/app/command-menu';
import { MobileNav } from '@/app/mobile-nav';
import { isNavItemActive, navGroupsForRole, titleForPath } from '@/app/nav';
import { TasksMenu } from '@/app/tasks-menu';
import { useTheme, type ThemePreference } from '@/app/theme';
import { formatBadge, useShellCounts, type ShellCounts } from '@/app/use-shell-counts';
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
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Kbd } from '@/components/ui/kbd';
import { Separator } from '@/components/ui/separator';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar';
import { Spinner } from '@/components/ui/spinner';
import { useLogout, useMe } from '@/features/auth/queries';
import { errorMessage } from '@/lib/api';
import { initials } from '@/lib/format';
import { APP_NAME, INSTANSI } from '@/lib/instansi';

/** Per-user key so one user's dismissal never hides the reminder for another user on the same tab. */
const DISMISS_NOTICE_KEY_PREFIX = 'sikap.dismissDefaultPwBanner';

const THEME_OPTIONS: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Terang', icon: Sun },
  { value: 'dark', label: 'Gelap', icon: Moon },
  { value: 'system', label: 'Ikuti sistem', icon: Monitor },
];

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

function roleLabel(user: SessionUser) {
  return user.role === 'Admin' ? 'Administrator TU' : 'Pegawai';
}

function UserAvatar({ user, className }: { user: SessionUser; className?: string }) {
  return (
    <Avatar className={className}>
      {user.fotoUrl ? <AvatarImage src={user.fotoUrl} alt="" /> : null}
      <AvatarFallback className="bg-accent-soft font-medium text-primary">{initials(user.nama)}</AvatarFallback>
    </Avatar>
  );
}

/** Account dropdown shared by the sidebar footer (desktop) and the header avatar (phones). */
function UserMenu({ user, trigger, side }: { user: SessionUser; trigger: ReactNode; side?: 'right' | 'bottom' }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const logout = useLogout();
  const navigate = useNavigate();
  const { preference, setPreference } = useTheme();
  const { setOpenMobile } = useSidebar();

  const handleLogout = (event: MouseEvent) => {
    event.preventDefault();
    logout.mutate(undefined, {
      onSuccess: () => toast.success('Anda telah keluar.'),
      onError: (error) => toast.error(errorMessage(error)),
      onSettled: () => {
        setConfirmOpen(false);
        void navigate('/login', { replace: true });
      },
    });
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
        <DropdownMenuContent side={side} align="end" sideOffset={8} className="w-64">
          <DropdownMenuLabel className="flex items-center gap-3 py-2">
            <UserAvatar user={user} className="size-9" />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate text-sm font-semibold text-foreground">{user.nama}</span>
              <span className="truncate text-xs font-normal text-muted-foreground tabular-nums">NIP {user.nip}</span>
            </span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem asChild>
              <Link to="/profil" onClick={() => setOpenMobile(false)}>
                <UserRound />
                Profil saya
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link to="/akun" onClick={() => setOpenMobile(false)}>
                <Settings />
                Pengaturan akun
                {user.isDefaultPassword ? (
                  <span className="ml-auto size-2 rounded-full bg-status-pending" aria-label="Password masih default" />
                ) : null}
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                {preference === 'dark' ? <Moon /> : preference === 'light' ? <Sun /> : <Monitor />}
                Tema
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup value={preference} onValueChange={(value) => setPreference(value as ThemePreference)}>
                  {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
                    <DropdownMenuRadioItem key={value} value={value}>
                      <Icon />
                      {label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => setConfirmOpen(true)}>
            <LogOut />
            Keluar
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={confirmOpen} onOpenChange={(open) => !logout.isPending && setConfirmOpen(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Keluar dari SIKAP?</AlertDialogTitle>
            <AlertDialogDescription>Anda perlu masuk kembali dengan NIP dan password untuk mengakses SIKAP.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={logout.isPending}>Batal</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={logout.isPending} onClick={handleLogout}>
              {logout.isPending ? <Spinner data-icon="inline-start" /> : <LogOut data-icon="inline-start" />}
              Keluar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function AppSidebar({ user, counts }: { user: SessionUser; counts: ShellCounts }) {
  const { pathname } = useLocation();
  const { setOpenMobile } = useSidebar();
  const groups = navGroupsForRole(user.role);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="px-3 pt-4 pb-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild tooltip={APP_NAME} className="hover:bg-transparent">
              <Link to="/" onClick={() => setOpenMobile(false)}>
                <img src={logoNtt} alt="" className="size-9 shrink-0 object-contain" />
                <div className="grid min-w-0 flex-1 text-left leading-tight">
                  <span className="truncate font-heading text-base font-semibold tracking-tight">{APP_NAME}</span>
                  <span className="truncate text-xs text-muted-foreground" title={INSTANSI}>
                    {INSTANSI}
                  </span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent className="px-1.5">
        {groups.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu className="gap-0.5">
                {group.items.map((item) => {
                  const active = isNavItemActive(item.to, pathname);
                  const badge = item.badgeKey ? counts[item.badgeKey] : 0;
                  return (
                    <SidebarMenuItem key={item.to}>
                      <SidebarMenuButton asChild isActive={active} tooltip={item.label}>
                        <NavLink
                          to={item.to}
                          end={item.to === '/'}
                          aria-current={active ? 'page' : undefined}
                          onClick={() => setOpenMobile(false)}
                        >
                          <item.icon />
                          <span>{item.label}</span>
                          {badge > 0 ? <span className="sr-only">({badge} menunggu)</span> : null}
                        </NavLink>
                      </SidebarMenuButton>
                      {badge > 0 ? (
                        <SidebarMenuBadge
                          aria-hidden="true"
                          className="top-2! rounded-full bg-status-pending-muted px-1.5 font-semibold text-status-pending peer-hover/menu-button:text-status-pending peer-data-active/menu-button:text-status-pending"
                        >
                          {formatBadge(badge)}
                        </SidebarMenuBadge>
                      ) : null}
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <UserMenu
              user={user}
              side="right"
              trigger={
                <SidebarMenuButton size="lg" tooltip={user.nama} className="data-open:bg-sidebar-accent">
                  <span className="relative">
                    <UserAvatar user={user} className="size-8 rounded-lg" />
                    {user.isDefaultPassword ? (
                      <span className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-status-pending ring-2 ring-sidebar" />
                    ) : null}
                  </span>
                  <div className="grid min-w-0 flex-1 text-left leading-tight">
                    <span className="truncate text-sm font-medium">{user.nama}</span>
                    <span className="truncate text-xs text-muted-foreground">{roleLabel(user)}</span>
                  </div>
                  <ChevronsUpDown className="ml-auto text-muted-foreground" />
                </SidebarMenuButton>
              }
            />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

/** Compact, dismissible reminder shown on Beranda only (the tasks menu keeps it reachable elsewhere). */
function DefaultPasswordNotice({ user }: { user: SessionUser }) {
  const storageKey = `${DISMISS_NOTICE_KEY_PREFIX}.${user.id}`;
  const [dismissed, setDismissed] = useState(() => {
    try {
      return sessionStorage.getItem(storageKey) === '1';
    } catch {
      return false;
    }
  });

  if (!user.isDefaultPassword || dismissed) return null;

  const dismiss = () => {
    try {
      sessionStorage.setItem(storageKey, '1');
    } catch {
      // Storage unavailable (private mode): hide for this render tree only.
    }
    setDismissed(true);
  };

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-status-pending/25 bg-status-pending-muted px-4 py-3 text-sm"
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-card text-status-pending shadow-card">
        <KeyRound className="size-4" aria-hidden="true" />
      </span>
      {/* basis-56: on phones the text keeps a readable width and the actions wrap below it. */}
      <p className="min-w-0 flex-1 basis-56">
        <span className="font-semibold">Password Anda masih default.</span>{' '}
        <span className="text-muted-foreground">Ganti agar akun tidak mudah ditebak.</span>
      </p>
      <div className="ml-auto flex items-center gap-1">
        <Button asChild size="sm">
          <Link to="/akun">Ganti password</Link>
        </Button>
        <Button size="icon-sm" variant="ghost" onClick={dismiss} aria-label="Tutup pengingat">
          <X />
        </Button>
      </div>
    </div>
  );
}

function SearchButton({ onOpen }: { onOpen: () => void }) {
  return (
    <>
      <Button
        variant="outline"
        className="hidden h-9 w-64 justify-start gap-2 bg-card px-3 font-normal text-muted-foreground shadow-none lg:inline-flex"
        onClick={onOpen}
      >
        <Search />
        <span className="flex-1 text-left">Cari…</span>
        <Kbd>{isMac ? '⌘' : 'Ctrl'}</Kbd>
        <Kbd>K</Kbd>
      </Button>
      <Button variant="ghost" size="icon" className="lg:hidden" onClick={onOpen} aria-label="Cari">
        <Search />
      </Button>
    </>
  );
}

function ShellHeader({ user, counts, onSearch }: { user: SessionUser; counts: ShellCounts; onSearch: () => void }) {
  const { pathname } = useLocation();
  const title = titleForPath(pathname);
  const isHome = pathname === '/';

  return (
    <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b bg-background/90 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/75 md:h-16 md:px-6">
      <SidebarTrigger className="-ml-1.5 hidden md:inline-flex" />
      <Separator orientation="vertical" className="mr-2 hidden data-[orientation=vertical]:h-4 md:block" />
      <Link to="/" className="flex shrink-0 items-center md:hidden" aria-label={`${APP_NAME} — Beranda`}>
        <img src={logoNtt} alt="" className="size-8 object-contain" />
      </Link>
      <Breadcrumb className="min-w-0 flex-1">
        <BreadcrumbList>
          <BreadcrumbItem className="hidden md:inline-flex">
            {isHome ? (
              <BreadcrumbPage>{APP_NAME}</BreadcrumbPage>
            ) : (
              <BreadcrumbLink asChild>
                <Link to="/">{APP_NAME}</Link>
              </BreadcrumbLink>
            )}
          </BreadcrumbItem>
          <BreadcrumbSeparator className="hidden md:inline-flex" />
          <BreadcrumbItem className="min-w-0">
            <BreadcrumbPage className="truncate font-medium">{title}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      <div className="flex items-center gap-1">
        <SearchButton onOpen={onSearch} />
        <TasksMenu user={user} counts={counts} />
        <div className="md:hidden">
          <UserMenu
            user={user}
            side="bottom"
            trigger={
              <Button variant="ghost" size="icon" aria-label={`Menu akun ${user.nama}`}>
                <UserAvatar user={user} className="size-8" />
              </Button>
            }
          />
        </div>
      </div>
    </header>
  );
}

function ShellBody({ user }: { user: SessionUser }) {
  const counts = useShellCounts(user);
  const { pathname } = useLocation();
  const [searchOpen, setSearchOpen] = useState(false);
  useCommandMenuHotkey(setSearchOpen);

  return (
    <>
      <AppSidebar user={user} counts={counts} />
      <SidebarInset className="min-w-0">
        <ShellHeader user={user} counts={counts} onSearch={() => setSearchOpen(true)} />
        {/* SidebarInset already renders <main>; this is the skip-link target inside it. */}
        <div id="main-content" tabIndex={-1} className="flex-1 outline-none">
          <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-6 px-4 pt-6 pb-28 sm:px-6 md:pb-10 lg:px-8 lg:pt-8">
            {pathname === '/' ? <DefaultPasswordNotice key={user.id} user={user} /> : null}
            <Outlet />
          </div>
        </div>
      </SidebarInset>
      <MobileNav user={user} counts={counts} />
      <CommandMenu user={user} open={searchOpen} onOpenChange={setSearchOpen} />
    </>
  );
}

export function AppShell() {
  const { data: user } = useMe();

  // RequireAuth guarantees a user; this guard only satisfies the type checker.
  if (!user) return null;

  return (
    <SidebarProvider>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:shadow-pop focus:ring-2 focus:ring-ring"
      >
        Lewati ke konten utama
      </a>
      <ShellBody user={user} />
    </SidebarProvider>
  );
}
