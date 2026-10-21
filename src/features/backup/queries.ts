import { useQuery } from '@tanstack/react-query';
import type { BackupJob, BackupJobResponse, BackupListResponse } from '@shared/backup';
import { api } from '@/lib/api';

export const backupKeys = {
  all: ['admin', 'backup'] as const,
  list: () => [...backupKeys.all, 'list'] as const,
};

export function fetchBackupList(signal?: AbortSignal): Promise<BackupListResponse> {
  return api<BackupListResponse>('/admin/backup', { signal });
}

export async function fetchBackupJob(jobId: string, signal?: AbortSignal): Promise<BackupJob> {
  const res = await api<BackupJobResponse>(`/admin/backup/${encodeURIComponent(jobId)}`, { signal });
  return res.job;
}

export async function createBackupJob(signal?: AbortSignal): Promise<BackupJob> {
  const res = await api<BackupJobResponse>('/admin/backup', { method: 'POST', signal });
  return res.job;
}

export async function stepBackupJob(jobId: string, signal?: AbortSignal): Promise<BackupJob> {
  const res = await api<BackupJobResponse>(`/admin/backup/${encodeURIComponent(jobId)}/step`, {
    method: 'POST',
    signal,
  });
  return res.job;
}

/** Fetched on mount/focus only; never polled. Progress comes from the user-initiated step loop. */
export function useBackupList() {
  return useQuery({
    queryKey: backupKeys.list(),
    queryFn: ({ signal }) => fetchBackupList(signal),
  });
}
