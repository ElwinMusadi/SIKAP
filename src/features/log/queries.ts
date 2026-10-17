import { useInfiniteQuery } from '@tanstack/react-query';
import type { LogResponse } from '@shared/administrasi';
import { api } from '@/lib/api';
import { logQueryString, type LogFilters } from './log-utils';

export const logKeys = {
  all: ['admin', 'log'] as const,
  list: (filters: LogFilters) => ['admin', 'log', filters] as const,
};

/** Cursor-paged audit log (25 rows/page). Every page is requested with the same filters. */
export function useAuditLog(filters: LogFilters, enabled = true) {
  return useInfiniteQuery({
    queryKey: logKeys.list(filters),
    queryFn: ({ pageParam, signal }) => api<LogResponse>(`/admin/log${logQueryString(filters, pageParam)}`, { signal }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
  });
}
