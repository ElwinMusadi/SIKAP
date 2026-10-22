import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateKunciApiRequest, KunciApiCreateResponse, KunciApiListResponse } from '@shared/integrasi';
import { api } from '@/lib/api';

export const kunciApiKeys = {
  all: ['admin', 'kunci-api'] as const,
};

export function useKunciApi() {
  return useQuery({
    queryKey: kunciApiKeys.all,
    queryFn: ({ signal }) => api<KunciApiListResponse>('/admin/kunci-api', { signal }),
  });
}

/** Key list and the activity log (APIKEY_* entries) change together. */
function useInvalidateKunci() {
  const queryClient = useQueryClient();
  return (): void => {
    void queryClient.invalidateQueries({ queryKey: kunciApiKeys.all });
    void queryClient.invalidateQueries({ queryKey: ['admin', 'log'] });
  };
}

/** The response holds the plain key exactly once; it is never cached in the query client. */
export function useBuatKunciApi() {
  const invalidate = useInvalidateKunci();
  return useMutation({
    mutationFn: (body: CreateKunciApiRequest) => api<KunciApiCreateResponse>('/admin/kunci-api', { method: 'POST', body }),
    onSuccess: () => invalidate(),
  });
}

export function useHapusKunciApi() {
  const invalidate = useInvalidateKunci();
  return useMutation({
    mutationFn: (id: number) => api<void>(`/admin/kunci-api/${id}`, { method: 'DELETE' }),
    onSuccess: () => invalidate(),
  });
}
