import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AdminPangkat,
  AdminRefResponse,
  AdminUnit,
  CreatePangkatRequest,
  CreateUnitRequest,
  UpdatePangkatRequest,
  UpdateUnitRequest,
} from '@shared/administrasi';
import { api } from '@/lib/api';

export const referensiKeys = {
  admin: ['admin', 'ref'] as const,
};

export function useAdminRef() {
  return useQuery({
    queryKey: referensiKeys.admin,
    queryFn: ({ signal }) => api<AdminRefResponse>('/admin/ref', { signal }),
  });
}

/** Fire-and-forget refresh of every cache that renders reference labels. */
function useInvalidateRef() {
  const queryClient = useQueryClient();
  return (): void => {
    const keys: readonly (readonly unknown[])[] = [referensiKeys.admin, ['ref'], ['me'], ['auth', 'me'], ['admin', 'pegawai'], ['admin', 'dashboard'], ['admin', 'log']];
    for (const queryKey of keys) void queryClient.invalidateQueries({ queryKey });
  };
}

export function useCreatePangkat() {
  const invalidate = useInvalidateRef();
  return useMutation({
    mutationFn: (body: CreatePangkatRequest) => api<{ item?: AdminPangkat } | undefined>('/admin/ref/pangkat', { method: 'POST', body }),
    onSuccess: () => invalidate(),
  });
}

export function useUpdatePangkat() {
  const invalidate = useInvalidateRef();
  return useMutation({
    mutationFn: ({ kode, body }: { kode: string; body: UpdatePangkatRequest }) =>
      // Kode contains "/" (III/a): always encode as a single path segment.
      api<{ item?: AdminPangkat } | undefined>(`/admin/ref/pangkat/${encodeURIComponent(kode)}`, { method: 'PATCH', body }),
    onSuccess: () => invalidate(),
  });
}

export function useCreateUnit() {
  const invalidate = useInvalidateRef();
  return useMutation({
    mutationFn: (body: CreateUnitRequest) => api<{ item?: AdminUnit } | undefined>('/admin/ref/unit', { method: 'POST', body }),
    onSuccess: () => invalidate(),
  });
}

export function useUpdateUnit() {
  const invalidate = useInvalidateRef();
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: UpdateUnitRequest }) =>
      api<{ item?: AdminUnit } | undefined>(`/admin/ref/unit/${encodeURIComponent(String(id))}`, { method: 'PATCH', body }),
    onSuccess: () => invalidate(),
  });
}
