import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/services/api';
import type { ExecutionRun } from '../types';

const IN_FLIGHT: ExecutionRun['status'][] = ['queued', 'preparing', 'running'];

export function isInFlight(status: ExecutionRun['status']): boolean {
  return IN_FLIGHT.includes(status);
}

export interface RunFilters {
  status?: string;
  project?: string;
}

/**
 * Filters are forwarded to `GET /execution`'s own `status`/`project` query
 * params rather than applied client-side — matches the same reasoning as
 * `useDevices`: the backend already supports them, so filtering there keeps
 * one source of truth for "what matched" instead of fetching everything and
 * hiding rows in the browser.
 */
export function useExecutionRuns(filters: RunFilters = {}) {
  const params = Object.fromEntries(Object.entries(filters).filter(([, v]) => v && v !== 'all'));
  return useQuery({
    queryKey: ['runs', params],
    queryFn: async () => (await api.get<ExecutionRun[]>('/execution', { params })).data,
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

/**
 * The run's stored log file.
 *
 * The WS stream only carries lines emitted while connected, so a finished run
 * (or one opened after the fact) has nothing to show without this. Fetched
 * only when the socket isn't live, so an in-flight run keeps using the stream
 * and doesn't double-render the same lines.
 */
export function useRunLog(runId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['runs', runId, 'logs'],
    queryFn: async () => (await api.get<string>(`/execution/${runId}/logs`)).data,
    enabled: Boolean(runId) && enabled,
    // A missing log is a real answer ("this run stored none"), not a transient
    // failure worth retrying.
    retry: false,
  });
}

/**
 * Projects selectable on the trigger form.
 *
 * Backed today by the distinct projects of past runs, which is a stopgap the
 * backend route documents: a project declared in config but never run yet
 * cannot appear. The `{ projects: string[] }` shape is deliberately what a
 * config-backed endpoint would return, so replacing the source changes nothing
 * here.
 */
export function useProjects() {
  return useQuery({
    queryKey: ['execution', 'projects'],
    queryFn: async () => (await api.get<{ projects: string[] }>('/execution/projects')).data.projects,
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
