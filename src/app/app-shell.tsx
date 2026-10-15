import { useState, type MouseEvent } from 'react';
import { KeyRound, LogOut, Settings, UserRound } from 'lucide-react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { toast } from 'sonner';
import type { SessionUser } from '@shared/api';
import logoNtt from '@/assets/logo-ntt.webp';
import { isNavItemActive, navGroupsForRole, titleForPath } from '@/app/nav';
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from '@/components/ui/sidebar';
import { Spinner } from '@/components/ui/spinner';
import { useLogout, useMe } from '@/features/auth/queries';
import { errorMessage } from '@/lib/api';
import { initials } from '@/lib/format';

/** Per-user key so one user's dismissal never hides the banner for another user on the same tab. */
const DISMISS_BANNER_KEY_PREFIX = 'sikap.dismissDefaultPwBanner';

function roleLabel(user: SessionUser) {
  return user.role === 'Admin' ? 'Administrator TU' : 'Pegawai';
}

function UserAvatar({ user, className }: { user: SessionUser; className?: string }) {
  return (
    <Avatar className={className}>
      {user.fotoUrl ? <AvatarImage src={user.fotoUrl} alt="" /> : null}
      <AvatarFallback>{initials(user.nama)}</AvatarFallback>
    </Avatar>
  );
}

function AppSidebar({ user }: { user: SessionUser }) {
  const { pathname } = useLocation();
  const groups = navGroupsForRole(user.role);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild tooltip="SIKAP">
              <Link to="/">
                <img src={logoNtt} alt="" className="size-8 shrink-0 object-contain" />
                <div className="grid min-w-0 flex-1 text-left leading-tight">
                  <span className="truncate font-heading text-sm font-semibold">SIKAP</span>
                  <span className="truncate text-xs text-sidebar-foreground/70">UPTD Pendapatan Daerah Kota Kupang</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {groups.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => {
                  const active = isNavItemActive(item.to, pathname);
                  return (
                    <SidebarMenuItem key={item.to}>
                      <SidebarMenuButton asChild isActive={active} tooltip={item.label}>
                        <NavLink to={item.to} end={item.to === '/'} aria-current={active ? 'page' : undefined}>
                          <item.icon />
                          <span>{item.label}</span>
                        </NavLink>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild tooltip={user.nama}>
              <Link to="/profil">
                <UserAvatar user={user} className="size-8 rounded-lg" />
                <div className="grid min-w-0 flex-1 text-left leading-tight">
                  <span className="truncate text-sm font-medium">{user.nama}</span>
                  <span className="truncate text-xs text-sidebar-foreground/70">{roleLabel(user)}</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

function UserMenu({ user }: { user: SessionUser }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const logout = useLogout();
  const navigate = useNavigate();

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
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className="h-9 gap-2 px-1.5" aria-label={`Menu akun ${user.nama}`}>
            <UserAvatar user={user} className="size-7" />
            <span className="hidden max-w-40 truncate text-sm font-medium md:inline">{user.nama}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel className="flex flex-col gap-0.5">
            <span className="truncate text-sm font-medium text-foreground">{user.nama}</span>
            <span className="truncate text-xs font-normal text-muted-foreground tabular-nums">NIP {user.nip}</span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem asChild>
              <Link to="/profil">
                <UserRound />
                Profil Saya
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link to="/akun">
                <Settings />
                Pengaturan Akun
              </Link>
            </DropdownMenuItem>
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

function DefaultPasswordBanner({ user }: { user: SessionUser }) {
  const storageKey = `${DISMISS_BANNER_KEY_PREFIX}.${user.id}`;
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
    <Alert className="border-status-pending/30 bg-status-pending-muted">
      <KeyRound className="text-status-pending" />
      <AlertTitle>Anda masih menggunakan password default</AlertTitle>
      <AlertDescription>
        <p>Demi keamanan akun, sebaiknya ganti password Anda.</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button asChild size="sm">
            <Link to="/akun">Ganti Password</Link>
          </Button>
          <Button size="sm" variant="ghost" onClick={dismiss}>
            Nanti saja
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}

export function AppShell() {
  const { data: user } = useMe();
  const { pathname } = useLocation();

  // RequireAuth guarantees a user; this guard only satisfies the type checker.
  if (!user) return null;

  const title = titleForPath(pathname);
  const isHome = pathname === '/';

  return (
    <SidebarProvider>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:shadow-md focus:ring-2 focus:ring-ring"
      >
        Lewati ke konten utama
      </a>
      <AppSidebar user={user} />
      <SidebarInset>
        <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/80">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 data-[orientation=vertical]:h-4" />
          <Breadcrumb className="min-w-0 flex-1">
            <BreadcrumbList>
              <BreadcrumbItem className="hidden sm:inline-flex">
                {isHome ? (
                  <BreadcrumbPage>SIKAP</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink asChild>
                    <Link to="/">SIKAP</Link>
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
              <BreadcrumbSeparator className="hidden sm:inline-flex" />
              <BreadcrumbItem className="min-w-0">
                <BreadcrumbPage className="truncate">{title}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          <UserMenu user={user} />
        </header>
        {/* SidebarInset already renders <main>; this is the skip-link target inside it. */}
        <div id="main-content" tabIndex={-1} className="flex-1 outline-none">
          <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
            <DefaultPasswordBanner key={user.id} user={user} />
            <Outlet />
          </div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
