import { keepPreviousData, useInfiniteQuery, useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { DecisionResponse, VerifikasiItem, VerifikasiQueueResponse } from '@shared/verifikasi';
import { api, isApiError } from '@/lib/api';
import { removeQueueItem, type QueueData } from './verifikasi-utils';

export const verifikasiKeys = {
  all: ['admin', 'verifikasi'] as const,
  queue: (jenis: string | null) => ['admin', 'verifikasi', jenis ?? 'all'] as const,
  /** Pending total for the sidebar badge (a number, not a page). */
  count: ['admin', 'verifikasi', 'count'] as const,
};

// Literal keys (not imported from features/dokumen) so the sidebar badge does not pull the
// upload code into the app-shell chunk. Keep in sync with dokumenKeys.adminPegawai / .mine.
const ADMIN_PEGAWAI_KEY = ['admin', 'pegawai'] as const;
const MY_DOCUMENTS_KEY = ['me', 'documents'] as const;

const DECISION_KEY = ['verifikasi', 'decision'] as const;

function queuePath(jenis: string | null, cursor: string | null): string {
  const params = new URLSearchParams();
  if (jenis) params.set('jenis', jenis);
  if (cursor) params.set('cursor', cursor);
  const qs = params.toString();
  return `/admin/verifikasi${qs ? `?${qs}` : ''}`;
}

export function useVerifikasiQueue(jenis: string | null) {
  return useInfiniteQuery({
    queryKey: verifikasiKeys.queue(jenis),
    queryFn: ({ pageParam, signal }) => api<VerifikasiQueueResponse>(queuePath(jenis, pageParam), { signal }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    // Keeps the filter options and list visible while another jenis loads (check isPlaceholderData).
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

/** Sidebar badge: pending total. */
export function useVerifikasiCount(enabled = true) {
  return useQuery({
    queryKey: verifikasiKeys.count,
    queryFn: async ({ signal }) => (await api<VerifikasiQueueResponse>('/admin/verifikasi', { signal })).total,
    enabled,
    staleTime: 60_000,
  });
}

/** True while any approve/reject request is in flight. */
export function useDecisionPending() {
  return useIsMutating({ mutationKey: DECISION_KEY }) > 0;
}

export function isStaleDecisionError(error: unknown) {
  return isApiError(error, 'CONFLICT') || isApiError(error, 'NOT_FOUND');
}

interface DecisionVars {
  item: VerifikasiItem;
  alasan?: string;
}

function useDecision(kind: 'approve' | 'reject') {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: [...DECISION_KEY, kind],
    mutationFn: ({ item, alasan }: DecisionVars) =>
      api<DecisionResponse>(`/admin/verifikasi/${item.arsipId}/${kind}`, {
        method: 'POST',
        body: kind === 'approve' ? { versi: item.versi } : { versi: item.versi, alasan },
      }),
    // An in-flight refetch could resurrect the item we are about to remove.
    onMutate: () => queryClient.cancelQueries({ queryKey: verifikasiKeys.all }),
    onSuccess: (res, { item }) => {
      queryClient.setQueriesData<QueueData | number>({ queryKey: verifikasiKeys.all }, (old) => {
        if (old === undefined) return old;
        if (typeof old === 'number') return res.sisaAntrean;
        return removeQueueItem(old, { arsipId: item.arsipId, jenisId: item.jenisDokumen.id, sisaAntrean: res.sisaAntrean });
      });
      void queryClient.invalidateQueries({ queryKey: ADMIN_PEGAWAI_KEY });
      void queryClient.invalidateQueries({ queryKey: MY_DOCUMENTS_KEY });
    },
    onError: (error) => {
      if (isStaleDecisionError(error)) toast.error('Dokumen telah berubah. Antrean dimuat ulang.');
    },
    onSettled: () => {
      // Background reconcile once the last concurrent decision settles (this one still counts).
      if (queryClient.isMutating({ mutationKey: DECISION_KEY }) <= 1) {
        void queryClient.invalidateQueries({ queryKey: verifikasiKeys.all });
      }
    },
  });
}

export function useApprove() {
  return useDecision('approve');
}

export function useReject() {
  return useDecision('reject');
}
