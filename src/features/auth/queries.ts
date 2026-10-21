import { queryOptions, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type {
  ChangePasswordRequest,
  ChangePasswordResponse,
  LoginRequest,
  LoginResponse,
  MeResponse,
  RevokeSessionsResponse,
  SessionsResponse,
  SessionUser,
} from '@shared/api';
import { api, isApiError } from '@/lib/api';

export const authKeys = {
  me: ['auth', 'me'] as const,
  sessions: ['auth', 'sessions'] as const,
};

export const meQueryOptions = queryOptions({
  queryKey: authKeys.me,
  queryFn: async ({ signal }): Promise<SessionUser | null> => {
    try {
      const res = await api<MeResponse>('/auth/me', { signal });
      return res.user;
    } catch (error) {
      if (isApiError(error, 'SESSION_EXPIRED')) return null;
      throw error;
    }
  },
  staleTime: 5 * 60_000,
});

export function useMe() {
  return useQuery(meQueryOptions);
}

/**
 * Set when the user is signed out on purpose (logout, lockout). RequireAuth then
 * redirects to plain `/login` instead of `/login?next=<current page>`.
 * Reset on the next successful login.
 */
let intentionalSignOut = false;

export function wasSignedOutIntentionally(): boolean {
  return intentionalSignOut;
}

/** Drops every cached query (incl. sessions) and marks the user as signed out. */
export function signOutLocally(queryClient: QueryClient) {
  intentionalSignOut = true;
  // removeQueries (not clear) so the in-flight mutation's per-call callbacks still fire.
  queryClient.removeQueries();
  queryClient.setQueryData(authKeys.me, null);
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: LoginRequest) => api<LoginResponse>('/auth/login', { method: 'POST', body }),
    onSuccess: ({ user }) => {
      intentionalSignOut = false;
      // A different user may sign in on the same tab: never reuse the previous user's cache.
      queryClient.removeQueries();
      queryClient.setQueryData(authKeys.me, user);
    },
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      try {
        await api<void>('/auth/logout', { method: 'POST' });
      } catch (error) {
        // Session already gone server-side: the user is signed out either way.
        if (isApiError(error, 'SESSION_EXPIRED')) return;
        throw error;
      }
    },
    onSettled: () => signOutLocally(queryClient),
  });
}

export function useChangePassword() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ChangePasswordRequest) =>
      api<ChangePasswordResponse>('/auth/change-password', { method: 'POST', body }),
    onSuccess: (res) => {
      queryClient.setQueryData(authKeys.me, res.user);
      void queryClient.invalidateQueries({ queryKey: authKeys.sessions });
    },
    onError: (error) => {
      // 5 wrong current passwords: server locks the account and revokes ALL sessions (423, not 401).
      if (isApiError(error, 'ACCOUNT_LOCKED')) signOutLocally(queryClient);
    },
  });
}

export function useSessions() {
  return useQuery({
    queryKey: authKeys.sessions,
    queryFn: async ({ signal }) => (await api<SessionsResponse>('/auth/sessions', { signal })).sessions,
  });
}

export function useRevokeSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<RevokeSessionsResponse>(`/auth/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: authKeys.sessions }),
  });
}

export function useRevokeOtherSessions() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api<RevokeSessionsResponse>('/auth/sessions/revoke-others', { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: authKeys.sessions }),
  });
}
