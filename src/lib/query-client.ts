import { QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { isApiError, setSessionExpiredListener } from '@/lib/api';

const ME_QUERY_KEY = ['auth', 'me'] as const;
const SESSION_EXPIRED_TOAST_ID = 'session-expired';

function shouldRetry(failureCount: number, error: unknown): boolean {
  if (isApiError(error)) {
    if (error.status >= 400 && error.status < 500) return false;
    if (error.code === 'NETWORK_ERROR') return failureCount < 1;
  }
  return failureCount < 2;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: shouldRetry,
    },
    mutations: {
      retry: false,
    },
  },
});

/** Minimal router surface needed here (avoids coupling to a specific router type). */
interface NavigableRouter {
  state: { location: { pathname: string; search: string } };
  navigate: (to: string, opts?: { replace?: boolean }) => unknown;
}

/**
 * Wires the API layer's 401 SESSION_EXPIRED signal to the app:
 * clears cached user data, informs the user once, and sends them to /login
 * with a `next` parameter so they return to where they were.
 */
export function installSessionExpiredHandler(router: NavigableRouter) {
  setSessionExpiredListener(() => {
    // Drop everything (incl. ['auth','sessions']) so the next user on this tab never sees stale data.
    queryClient.removeQueries();
    queryClient.setQueryData(ME_QUERY_KEY, null);

    toast.warning('Sesi Anda telah berakhir. Silakan masuk kembali.', {
      id: SESSION_EXPIRED_TOAST_ID,
    });

    const { pathname, search } = router.state.location;
    if (pathname === '/login') return;
    void router.navigate(`/login?next=${encodeURIComponent(pathname + search)}`, { replace: true });
  });
}
