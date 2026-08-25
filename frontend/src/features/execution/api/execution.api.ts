import { useQuery } from '@tanstack/react-query';
import { api } from '@/services/api';
import type { ExecutionRun } from '../types';

const IN_FLIGHT: ExecutionRun['status'][] = ['queued', 'preparing', 'running'];

export function useExecutionRuns() {
  return useQuery({
    queryKey: ['runs'],
    queryFn: async () => (await api.get<ExecutionRun[]>('/execution')).data,
  });
}

export function useExecutionRun(runId: string | undefined) {
  return useQuery({
    queryKey: ['runs', runId],
    queryFn: async () => (await api.get<ExecutionRun>(`/execution/${runId}`)).data,
    enabled: Boolean(runId),
    // Poll while the run is in flight; the WS stream can replace this later.
    refetchInterval: (query) => (query.state.data && IN_FLIGHT.includes(query.state.data.status) ? 1000 : false),
  });
}
