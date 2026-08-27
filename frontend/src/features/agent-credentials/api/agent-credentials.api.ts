import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/services/api';
import type { AgentCredential, IssuedAgentCredential } from '../types';

/** Admin-only on the backend — only mount this behind a `can('admin')` gate. */
export function useAgentCredentials() {
  return useQuery({
    queryKey: ['agent-credentials'],
    queryFn: async () => (await api.get<AgentCredential[]>('/agent-credentials')).data,
  });
}

/**
 * The mutation response is the only place the raw token ever appears — the
 * backend never returns it again after this call. Callers must capture it
 * from `onSuccess`/the returned promise, not re-derive it from the query
 * cache (which only ever holds the redacted `AgentCredential` shape).
 */
export function useIssueAgentCredential() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { machineId: string; label?: string }) =>
      (await api.post<IssuedAgentCredential>('/agent-credentials', input)).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['agent-credentials'] });
    },
  });
}

export function useRevokeAgentCredential() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await api.post<AgentCredential>(`/agent-credentials/${id}/revoke`)).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['agent-credentials'] });
    },
  });
}
