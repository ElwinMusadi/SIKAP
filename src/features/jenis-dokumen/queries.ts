import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AdminJenisDokumen, AdminJenisResponse, CreateJenisRequest, UpdateJenisRequest } from '@shared/administrasi';
import { api } from '@/lib/api';

export const jenisKeys = {
  all: ['admin', 'jenis-dokumen'] as const,
};

export function useAdminJenis() {
  return useQuery({
    queryKey: jenisKeys.all,
    queryFn: ({ signal }) => api<AdminJenisResponse>('/admin/jenis-dokumen', { signal }),
  });
}

/**
 * Required-matrix and active changes recalculate completeness everywhere. Fire-and-forget
 * (returns void) so mutateAsync resolves without waiting for refetches that may unmount the caller.
 */
function useInvalidateJenis() {
  const queryClient = useQueryClient();
  return (): void => {
    const keys: readonly (readonly unknown[])[] = [
      ['ref'],
      ['me'],
      ['admin', 'pegawai'],
      ['admin', 'dashboard'],
      ['admin', 'verifikasi'],
      jenisKeys.all,
      // Writes are audited.
      ['admin', 'log'],
    ];
    for (const queryKey of keys) void queryClient.invalidateQueries({ queryKey });
  };
}

export function useCreateJenis() {
  const invalidate = useInvalidateJenis();
  return useMutation({
    mutationFn: (body: CreateJenisRequest) => api<{ item: AdminJenisDokumen }>('/admin/jenis-dokumen', { method: 'POST', body }),
    onSuccess: () => invalidate(),
  });
}

export function useUpdateJenis() {
  const invalidate = useInvalidateJenis();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateJenisRequest }) =>
      api<{ item: AdminJenisDokumen }>(`/admin/jenis-dokumen/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
    onSuccess: () => invalidate(),
  });
}
