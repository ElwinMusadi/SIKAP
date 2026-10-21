import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { StatusAkun } from '@shared/enums';
import type {
  AccountActionResponse,
  AdminDashboardResponse,
  CreatePegawaiRequest,
  DeletePegawaiResponse,
  PegawaiDetailResponse,
  PegawaiListResponse,
  UpdatePegawaiRequest,
} from '@shared/pegawai';
import { api } from '@/lib/api';
import { listQueryString, type PegawaiListParams } from './pegawai-utils';

export const pegawaiKeys = {
  /** Prefix for every admin per-employee query (list, detail, documents). */
  all: ['admin', 'pegawai'] as const,
  list: (query: PegawaiListParams) => ['admin', 'pegawai', 'list', query] as const,
  detail: (id: number) => ['admin', 'pegawai', id] as const,
  dashboard: ['admin', 'dashboard'] as const,
};

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

export function usePegawaiList(query: PegawaiListParams) {
  return useQuery({
    queryKey: pegawaiKeys.list(query),
    queryFn: ({ signal }) => api<PegawaiListResponse>(`/admin/pegawai${listQueryString(query)}`, { signal }),
    // Filters, sort and paging keep the previous rows visible (check isPlaceholderData).
    placeholderData: keepPreviousData,
  });
}

export function usePegawaiDetail(id: number | null) {
  return useQuery({
    queryKey: pegawaiKeys.detail(id ?? 0),
    queryFn: ({ signal }) => api<PegawaiDetailResponse>(`/admin/pegawai/${id}`, { signal }),
    enabled: id !== null,
  });
}

export function useAdminDashboard(enabled = true) {
  return useQuery({
    queryKey: pegawaiKeys.dashboard,
    queryFn: ({ signal }) => api<AdminDashboardResponse>('/admin/dashboard', { signal }),
    enabled,
  });
}

/* ------------------------------------------------------------------ */
/* Mutations                                                           */
/* ------------------------------------------------------------------ */

/**
 * Refresh every cache an admin action on an employee can affect. Fire-and-forget on purpose:
 * a hook-level callback that RETURNS the invalidate promise makes TanStack wait for the
 * refetch before running `mutate(..., { onSuccess })`, and by then the refetch may have
 * unmounted the calling component (deleted detail page → 404, restored row leaves the
 * Terhapus tab), silently dropping its toast/navigation.
 */
function useInvalidatePegawai() {
  const queryClient = useQueryClient();
  return (): void => {
    const keys: readonly (readonly unknown[])[] = [
      pegawaiKeys.all,
      pegawaiKeys.dashboard,
      // Soft delete cancels pending pengajuan and removes documents from the queue.
      ['admin', 'pengajuan'],
      ['admin', 'verifikasi'],
      // The admin may have edited their own row (nama, jabatan, status).
      ['auth', 'me'],
      ['me'],
    ];
    for (const queryKey of keys) void queryClient.invalidateQueries({ queryKey });
  };
}

export function useCreatePegawai() {
  const invalidate = useInvalidatePegawai();
  return useMutation({
    mutationFn: (body: CreatePegawaiRequest) => api<PegawaiDetailResponse>('/admin/pegawai', { method: 'POST', body }),
    onSuccess: () => void invalidate(),
  });
}

export function useUpdatePegawai() {
  const queryClient = useQueryClient();
  const invalidate = useInvalidatePegawai();
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: UpdatePegawaiRequest }) =>
      api<PegawaiDetailResponse>(`/admin/pegawai/${id}`, { method: 'PATCH', body }),
    onSuccess: (data, { id }) => {
      // The response is fresh: show it immediately, then refresh lists/dashboard in the background.
      if (data?.pegawai) queryClient.setQueryData(pegawaiKeys.detail(id), data);
      void invalidate();
    },
  });
}

export function useSetStatusAkun() {
  const invalidate = useInvalidatePegawai();
  return useMutation({
    mutationFn: ({ id, statusAkun }: { id: number; statusAkun: StatusAkun }) =>
      api<AccountActionResponse>(`/admin/pegawai/${id}/status`, { method: 'POST', body: { statusAkun } }),
    onSettled: () => invalidate(),
  });
}

export function useResetPassword() {
  const invalidate = useInvalidatePegawai();
  return useMutation({
    mutationFn: (id: number) => api<AccountActionResponse>(`/admin/pegawai/${id}/reset-password`, { method: 'POST' }),
    onSettled: () => invalidate(),
  });
}

export function useUnlock() {
  const invalidate = useInvalidatePegawai();
  return useMutation({
    mutationFn: (id: number) => api<AccountActionResponse>(`/admin/pegawai/${id}/unlock`, { method: 'POST' }),
    onSettled: () => invalidate(),
  });
}

export function useDeletePegawai() {
  const invalidate = useInvalidatePegawai();
  return useMutation({
    mutationFn: (id: number) => api<DeletePegawaiResponse>(`/admin/pegawai/${id}`, { method: 'DELETE' }),
    onSettled: () => invalidate(),
  });
}

export function useRestorePegawai() {
  const invalidate = useInvalidatePegawai();
  return useMutation({
    mutationFn: (id: number) => api<AccountActionResponse>(`/admin/pegawai/${id}/restore`, { method: 'POST' }),
    onSettled: () => invalidate(),
  });
}
