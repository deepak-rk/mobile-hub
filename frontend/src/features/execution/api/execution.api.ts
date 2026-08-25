import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/services/api';
import type { ExecutionRun } from '../types';

const IN_FLIGHT: ExecutionRun['status'][] = ['queued', 'preparing', 'running'];

export function isInFlight(status: ExecutionRun['status']): boolean {
  return IN_FLIGHT.includes(status);
}

export function useExecutionRuns() {
  return useQuery({
    queryKey: ['runs'],
    queryFn: async () => (await api.get<ExecutionRun[]>('/execution')).data,
    // Keep the list moving while anything is still running.
    refetchInterval: (query) => (query.state.data?.some((r) => isInFlight(r.status)) ? 3000 : false),
  });
}

/**
 * `livePush` should be true when a WebSocket is delivering this run's events:
 * the stream invalidates the query on every transition, so polling on top of
 * it is redundant traffic. Polling stays as the fallback whenever the socket
 * isn't connected, so the page is never stale just because the socket dropped.
 */
export function useExecutionRun(runId: string | undefined, livePush = false) {
  return useQuery({
    queryKey: ['runs', runId],
    queryFn: async () => (await api.get<ExecutionRun>(`/execution/${runId}`)).data,
    enabled: Boolean(runId),
    refetchInterval: (query) => {
      if (livePush) return false;
      return query.state.data && isInFlight(query.state.data.status) ? 1000 : false;
    },
  });
}

export interface TriggerRunInput {
  machineId: string;
  deviceUdid: string;
  project: string;
  branch: string;
  suite: string;
  setup?: { command: string; args: string[] };
  run: { command: string; args: string[] };
}

export function useTriggerRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: TriggerRunInput) => (await api.post<ExecutionRun>('/execution', input)).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['runs'] });
      void qc.invalidateQueries({ queryKey: ['devices'] });
    },
  });
}

export function useCancelRun(runId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => (await api.post(`/execution/${runId}/cancel`)).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['runs'] });
      void qc.invalidateQueries({ queryKey: ['devices'] });
    },
  });
}
