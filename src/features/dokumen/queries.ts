import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type {
  DokumenItem,
  DokumenItemResponse,
  DokumenListResponse,
  RiwayatResponse,
  RollbackRequest,
} from '@shared/dokumen';
import { profilKeys } from '@/features/profil/queries';
import { api, apiUploadRaw } from '@/lib/api';
import { abortError, buildUploadHeaders, isAbortError, sha256Hex, type UploadStage } from './upload-flow';

export const dokumenKeys = {
  mine: ['me', 'documents'] as const,
  /** Prefix for every admin per-employee query (documents included). */
  adminPegawai: ['admin', 'pegawai'] as const,
  admin: (pegawaiId: number) => ['admin', 'pegawai', pegawaiId, 'documents'] as const,
  document: (arsipId: number) => ['documents', arsipId] as const,
  riwayat: (arsipId: number) => ['documents', arsipId, 'riwayat'] as const,
};

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

export function useDocuments() {
  return useQuery({
    queryKey: dokumenKeys.mine,
    queryFn: ({ signal }) => api<DokumenListResponse>('/me/documents', { signal }),
  });
}

/** Admin view of another employee's archive (Phase 6). */
export function useAdminDocuments(pegawaiId: number | null | undefined) {
  return useQuery({
    queryKey: dokumenKeys.admin(pegawaiId ?? 0),
    queryFn: ({ signal }) => api<DokumenListResponse>(`/admin/pegawai/${pegawaiId}/documents`, { signal }),
    enabled: pegawaiId !== null && pegawaiId !== undefined,
  });
}

/** History of one arsip; pass enabled=false until the history section is opened. */
export function useRiwayat(arsipId: number | null | undefined, enabled = true) {
  return useQuery({
    queryKey: dokumenKeys.riwayat(arsipId ?? 0),
    queryFn: ({ signal }) => api<RiwayatResponse>(`/documents/${arsipId}/riwayat`, { signal }),
    enabled: enabled && arsipId !== null && arsipId !== undefined,
  });
}

/* ------------------------------------------------------------------ */
/* Cache helpers                                                       */
/* ------------------------------------------------------------------ */

/**
 * Replaces an item in the employee's own list. `match` guards admin mutations: an admin acting
 * on another employee's arsip must not overwrite the same jenis in the admin's own archive.
 */
function replaceMine(queryClient: QueryClient, item: DokumenItem, match: (current: DokumenItem) => boolean) {
  queryClient.setQueryData<DokumenListResponse>(dokumenKeys.mine, (data) => {
    if (!data) return data;
    const index = data.items.findIndex((i) => i.jenisDokumenId === item.jenisDokumenId && match(i));
    if (index < 0) return data;
    const items = data.items.slice();
    items[index] = item;
    return { ...data, items };
  });
}

function invalidateDocuments(queryClient: QueryClient, arsipIds: (number | undefined)[]) {
  const tasks = [
    // Summary/counts change with every mutation: refetch after the optimistic item swap.
    queryClient.invalidateQueries({ queryKey: dokumenKeys.mine }),
    queryClient.invalidateQueries({ queryKey: dokumenKeys.adminPegawai }),
    queryClient.invalidateQueries({ queryKey: profilKeys.dashboard }),
  ];
  for (const id of new Set(arsipIds)) {
    if (id !== undefined) tasks.push(queryClient.invalidateQueries({ queryKey: dokumenKeys.document(id) }));
  }
  return Promise.all(tasks);
}

const ownsArsip = (arsipId: number) => (item: DokumenItem) => item.arsip?.id === arsipId || item.deleted?.id === arsipId;

/* ------------------------------------------------------------------ */
/* Mutations                                                           */
/* ------------------------------------------------------------------ */

export interface UploadDocumentVariables {
  jenisId: string;
  file: File;
  signal?: AbortSignal;
  /** 'hashing' while computing the SHA-256, then 'uploading' once bytes are sent. */
  onStage?: (stage: UploadStage) => void;
  onProgress?: (percent: number) => void;
}

/** PUT /api/me/documents/:jenisId with the raw file body + X-File-Name / X-Content-SHA256. */
export function useUploadDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ jenisId, file, signal, onStage, onProgress }: UploadDocumentVariables) => {
      onStage?.('hashing');
      const sha256 = await sha256Hex(await file.arrayBuffer());
      if (signal?.aborted) throw abortError();
      onStage?.('uploading');
      return apiUploadRaw<DokumenItemResponse>(`/me/documents/${encodeURIComponent(jenisId)}`, file, {
        method: 'PUT',
        headers: buildUploadHeaders(file, sha256),
        signal,
        onProgress,
      });
    },
    onSuccess: ({ item }) => {
      replaceMine(queryClient, item, () => true);
      // Not returned: the caller's toast/close must not wait for the background refetch.
      void invalidateDocuments(queryClient, [item.arsip?.id]);
    },
    onError: (error) => {
      // An abort after the body was fully sent may still have been committed server-side.
      if (isAbortError(error)) void queryClient.invalidateQueries({ queryKey: dokumenKeys.mine });
    },
  });
}

export function useDeleteDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (arsipId: number) => api<DokumenItemResponse>(`/documents/${arsipId}`, { method: 'DELETE' }),
    onSuccess: ({ item }, arsipId) => {
      replaceMine(queryClient, item, ownsArsip(arsipId));
      return invalidateDocuments(queryClient, [arsipId]);
    },
  });
}

export function useRestoreDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (arsipId: number) => api<DokumenItemResponse>(`/documents/${arsipId}/restore`, { method: 'POST' }),
    onSuccess: ({ item }, arsipId) => {
      replaceMine(queryClient, item, ownsArsip(arsipId));
      return invalidateDocuments(queryClient, [arsipId, item.arsip?.id]);
    },
  });
}

export function useRollbackDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ arsipId, versi }: { arsipId: number } & RollbackRequest) =>
      api<DokumenItemResponse>(`/documents/${arsipId}/rollback`, { method: 'POST', body: { versi } }),
    onSuccess: ({ item }, { arsipId }) => {
      replaceMine(queryClient, item, ownsArsip(arsipId));
      return invalidateDocuments(queryClient, [arsipId]);
    },
  });
}
