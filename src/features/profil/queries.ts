import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SessionUser } from '@shared/api';
import type { StatusPengajuan } from '@shared/enums';
import type {
  AdminPengajuanListResponse,
  CreatePengajuanRequest,
  DashboardResponse,
  PengajuanListResponse,
  PengajuanResponse,
  PhotoResponse,
  ProfileResponse,
  RefResponse,
  UpdateProfileRequest,
} from '@shared/profile';
import { authKeys } from '@/features/auth/queries';
import { api, apiUpload } from '@/lib/api';

export const profilKeys = {
  ref: ['ref'] as const,
  profile: ['me', 'profile'] as const,
  dashboard: ['me', 'dashboard'] as const,
  pengajuan: ['me', 'pengajuan'] as const,
  admin: ['admin', 'pengajuan'] as const,
  adminByStatus: (status: StatusPengajuan) => ['admin', 'pengajuan', status] as const,
};

/* ------------------------------------------------------------------ */
/* Reference data                                                      */
/* ------------------------------------------------------------------ */

/** GET /api/ref. Named `useRefData` so it never shadows React's `useRef`. */
export function useRefData() {
  return useQuery({
    queryKey: profilKeys.ref,
    queryFn: ({ signal }) => api<RefResponse>('/ref', { signal }),
    staleTime: 5 * 60_000,
  });
}

/* ------------------------------------------------------------------ */
/* Profile + photo                                                     */
/* ------------------------------------------------------------------ */

export function useProfile() {
  return useQuery({
    queryKey: profilKeys.profile,
    queryFn: ({ signal }) => api<ProfileResponse>('/me/profile', { signal }),
  });
}

export function useUpdateProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateProfileRequest) => api<ProfileResponse>('/me/profile', { method: 'PATCH', body }),
    onSuccess: (data) => {
      queryClient.setQueryData(profilKeys.profile, data);
      void queryClient.invalidateQueries({ queryKey: profilKeys.dashboard });
    },
  });
}

export function useUploadPhoto() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ blob, filename, onProgress }: { blob: Blob; filename: string; onProgress?: (p: number) => void }) => {
      const form = new FormData();
      form.append('file', blob, filename);
      return apiUpload<PhotoResponse>('/me/photo', form, { method: 'PUT', onProgress });
    },
    onSuccess: ({ fotoUrl }) => {
      queryClient.setQueryData<SessionUser | null>(authKeys.me, (u) => u && { ...u, fotoUrl });
      // Only the photo URL changes: unsaved form edits elsewhere are untouched.
      queryClient.setQueryData<ProfileResponse>(profilKeys.profile, (d) =>
        d ? { ...d, profile: { ...d.profile, fotoUrl } } : d,
      );
    },
  });
}

export function useDashboard(enabled = true) {
  return useQuery({
    queryKey: profilKeys.dashboard,
    queryFn: ({ signal }) => api<DashboardResponse>('/me/dashboard', { signal }),
    enabled,
  });
}

/* ------------------------------------------------------------------ */
/* Pengajuan (employee)                                                */
/* ------------------------------------------------------------------ */

function useInvalidateMine() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: profilKeys.profile }),
      queryClient.invalidateQueries({ queryKey: profilKeys.dashboard }),
      queryClient.invalidateQueries({ queryKey: profilKeys.pengajuan }),
    ]);
}

export function useMyPengajuan() {
  return useQuery({
    queryKey: profilKeys.pengajuan,
    queryFn: ({ signal }) => api<PengajuanListResponse>('/me/pengajuan', { signal }),
  });
}

export function useCreatePengajuan() {
  const invalidate = useInvalidateMine();
  return useMutation({
    mutationFn: (body: CreatePengajuanRequest) => api<PengajuanResponse>('/me/pengajuan', { method: 'POST', body }),
    onSuccess: () => invalidate(),
  });
}

export function useCancelPengajuan() {
  const invalidate = useInvalidateMine();
  return useMutation({
    mutationFn: (id: number) => api<PengajuanResponse | undefined>(`/me/pengajuan/${id}`, { method: 'DELETE' }),
    onSuccess: () => invalidate(),
  });
}

/* ------------------------------------------------------------------ */
/* Pengajuan (admin)                                                   */
/* ------------------------------------------------------------------ */

export function useAdminPengajuan(status: StatusPengajuan, enabled = true) {
  return useQuery({
    queryKey: profilKeys.adminByStatus(status),
    queryFn: ({ signal }) =>
      api<AdminPengajuanListResponse>(`/admin/pengajuan?status=${encodeURIComponent(status)}`, { signal }),
    enabled,
    // Shared by the sidebar badge, beranda, and this page: avoid refetching on every mount.
    staleTime: 60_000,
    // Keeps tab counts visible while another status tab loads (check isPlaceholderData for the list).
    placeholderData: keepPreviousData,
  });
}

export function useApprovePengajuan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, catatan }: { id: number; catatan?: string }) =>
      api<PengajuanResponse>(`/admin/pengajuan/${id}/approve`, { method: 'POST', body: catatan ? { catatan } : {} }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: profilKeys.admin }),
  });
}

export function useRejectPengajuan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, catatan }: { id: number; catatan: string }) =>
      api<PengajuanResponse>(`/admin/pengajuan/${id}/reject`, { method: 'POST', body: { catatan } }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: profilKeys.admin }),
  });
}
