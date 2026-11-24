import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/services/api';
import type { Host, HostAgentCredential } from '../types';

export function useHosts() {
  return useQuery({
    queryKey: ['hosts'],
    queryFn: async () => (await api.get<Host[]>('/hosts')).data,
  });
}

/**
 * Per-host agent credential health. `GET /api/agent-credentials` is
 * admin-only on the backend (unlike `/hosts`), so `enabled` must be gated on
 * `can('admin')` at the call site — same restriction the dedicated
 * agent-credentials page enforces by not rendering its data-fetching
 * component at all for a non-admin. Shares its query key with that page's
 * hook, so the two pages share one cache entry instead of double-fetching.
 */
export function useHostCredentials(enabled: boolean) {
  return useQuery({
    queryKey: ['agent-credentials'],
    queryFn: async () => (await api.get<HostAgentCredential[]>('/agent-credentials')).data,
    enabled,
  });
}

/** Admin: remove a host from the lab (or let it back in). Its devices and work are released hub-side. */
export function useSetHostBlocked(machineId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { blocked: boolean; reason?: string }) =>
      (
        await api.post<Host>(
          `/hosts/${encodeURIComponent(machineId)}/${input.blocked ? 'block' : 'unblock'}`,
          input.blocked ? { reason: input.reason } : {},
        )
      ).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['hosts'] });
      void qc.invalidateQueries({ queryKey: ['devices'] });
    },
  });
}

