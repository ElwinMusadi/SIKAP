import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter, Outlet } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { RefreshCw, TriangleAlert } from 'lucide-react';
import { ThemeProvider } from '@/app/theme';
import { FullPageLoader } from '@/components/full-page-loader';
import { NotFound } from '@/components/not-found';
import { Button } from '@/components/ui/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { RedirectIfAuthed, RequireAuth, RequireRole } from '@/features/auth/guards';
import { installSessionExpiredHandler, queryClient } from '@/lib/query-client';
import './index.css';

function RouteError() {
  return (
    <div className="flex min-h-svh items-center justify-center bg-background p-6">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <TriangleAlert />
          </EmptyMedia>
          <EmptyTitle>Terjadi kesalahan</EmptyTitle>
          <EmptyDescription>Halaman gagal dimuat. Muat ulang halaman untuk mencoba lagi.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button onClick={() => window.location.reload()}>
            <RefreshCw data-icon="inline-start" />
            Muat ulang
          </Button>
        </EmptyContent>
      </Empty>
    </div>
  );
}

const router = createBrowserRouter([
  {
    element: <Outlet />,
    errorElement: <RouteError />,
    hydrateFallbackElement: <FullPageLoader />,
    children: [
      {
        path: '/login',
        element: <RedirectIfAuthed />,
        children: [
          {
            index: true,
            lazy: async () => ({ Component: (await import('./features/auth/login-page')).default }),
          },
        ],
      },
      {
        element: <RequireAuth />,
        children: [
          {
            // Lazy so the sidebar/dropdown/dialog code is not part of the login bundle.
            lazy: async () => ({ Component: (await import('./app/app-shell')).AppShell }),
            children: [
              {
                index: true,
                lazy: async () => ({ Component: (await import('./features/beranda/beranda-page')).default }),
              },
              {
                path: 'profil',
                lazy: async () => ({ Component: (await import('./features/profil/profil-page')).default }),
              },
              {
                path: 'dokumen',
                lazy: async () => ({ Component: (await import('./features/dokumen/dokumen-page')).default }),
              },
              {
                path: 'akun',
                lazy: async () => ({ Component: (await import('./features/akun/akun-page')).default }),
              },
              {
                path: 'admin',
                element: <RequireRole role="Admin" />,
                children: [
                  {
                    path: 'pegawai',
                    lazy: async () => ({ Component: (await import('./features/pegawai/pegawai-list-page')).default }),
                  },
                  {
                    path: 'pegawai/:id',
                    lazy: async () => ({ Component: (await import('./features/pegawai/pegawai-detail-page')).default }),
                  },
                  {
                    path: 'verifikasi',
                    lazy: async () => ({ Component: (await import('./features/verifikasi/verifikasi-page')).default }),
                  },
                  {
                    path: 'pengajuan',
                    lazy: async () => ({
                      Component: (await import('./features/pengajuan/admin-pengajuan-page')).default,
                    }),
                  },
                  {
                    path: 'log',
                    lazy: async () => ({ Component: (await import('./features/log/log-page')).default }),
                  },
                  {
                    path: 'jenis-dokumen',
                    lazy: async () => ({ Component: (await import('./features/jenis-dokumen/jenis-dokumen-page')).default }),
                  },
                  {
                    path: 'pengaturan',
                    lazy: async () => ({ Component: (await import('./features/pengaturan/pengaturan-page')).default }),
                  },
                ],
              },
            ],
          },
        ],
      },
      // Living design-system page for visual QA; dev builds only (never shipped).
      ...(import.meta.env.DEV
        ? [{ path: '/_design', lazy: async () => ({ Component: (await import('./app/design-page')).default }) }]
        : []),
      { path: '*', element: <NotFound /> },
    ],
  },
]);

installSessionExpiredHandler(router);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <RouterProvider router={router} />
          <Toaster richColors position="top-right" closeButton />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
