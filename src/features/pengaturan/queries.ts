import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { NotifSettings, TestWhatsAppResponse, UpdateWhatsAppRequest, WhatsAppSettings } from '@shared/verifikasi';
import { api } from '@/lib/api';

export const pengaturanKeys = {
  notifications: ['admin', 'settings', 'notifications'] as const,
  whatsapp: ['admin', 'settings', 'whatsapp'] as const,
};

/* ------------------------------------------------------------------ */
/* Notifications                                                       */
/* ------------------------------------------------------------------ */

export function useNotifSettings() {
  return useQuery({
    queryKey: pengaturanKeys.notifications,
    queryFn: ({ signal }) => api<NotifSettings>('/admin/settings/notifications', { signal }),
  });
}

function isNotifSettings(value: unknown): value is NotifSettings {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as NotifSettings).dokumenBaru === 'boolean' &&
    typeof (value as NotifSettings).dokumenApproved === 'boolean' &&
    typeof (value as NotifSettings).dokumenRejected === 'boolean'
  );
}

/** PUT the full object with an optimistic update; rolls back on error. Callers serialise via isPending. */
export function useUpdateNotifSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: NotifSettings) => api<NotifSettings | undefined>('/admin/settings/notifications', { method: 'PUT', body }),
    onMutate: async (next) => {
      await queryClient.cancelQueries({ queryKey: pengaturanKeys.notifications });
      const previous = queryClient.getQueryData<NotifSettings>(pengaturanKeys.notifications);
      queryClient.setQueryData(pengaturanKeys.notifications, next);
      return { previous };
    },
    onError: (_error, _next, context) => {
      if (context?.previous) queryClient.setQueryData(pengaturanKeys.notifications, context.previous);
    },
    onSuccess: (data) => {
      if (isNotifSettings(data)) queryClient.setQueryData(pengaturanKeys.notifications, data);
    },
  });
}

/* ------------------------------------------------------------------ */
/* WhatsApp                                                            */
/* ------------------------------------------------------------------ */

export function useWhatsAppSettings() {
  return useQuery({
    queryKey: pengaturanKeys.whatsapp,
    queryFn: ({ signal }) => api<WhatsAppSettings>('/admin/settings/whatsapp', { signal }),
  });
}

function isWhatsAppSettings(value: unknown): value is WhatsAppSettings {
  return typeof value === 'object' && value !== null && 'provider' in value && 'outbox' in value && 'fonnte' in value;
}

export function useUpdateWhatsApp() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateWhatsAppRequest) =>
      api<WhatsAppSettings | undefined>('/admin/settings/whatsapp', { method: 'PUT', body }),
    onSuccess: async (data) => {
      if (isWhatsAppSettings(data)) queryClient.setQueryData(pengaturanKeys.whatsapp, data);
      // Await reconciliation before clearing the draft: PUT may legitimately return no body.
      await queryClient.invalidateQueries({ queryKey: pengaturanKeys.whatsapp });
    },
  });
}

export function useTestWhatsApp() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api<TestWhatsAppResponse>('/admin/settings/whatsapp/test', { method: 'POST', body: {} }),
    // The test message goes through the outbox counters too.
    onSettled: () => queryClient.invalidateQueries({ queryKey: pengaturanKeys.whatsapp }),
  });
}
