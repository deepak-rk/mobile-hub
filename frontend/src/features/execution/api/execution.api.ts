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
  deviceUdid?: string;
  /** Host-scopes `deviceUdid` — udids like `emulator-5554` repeat across hosts. */
  machineId?: string;
  /** Exact suite, set by analytics links so a breakdown row opens its own runs. */
  suite?: string;
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
export interface ProjectOption {
  id: string;
  displayName: string;
  /**
   * Declared in org/project YAML, as opposed to merely seen in run history.
   * Only a declared project carries its own automation config; an undeclared
   * one silently falls back to the org defaults, which the picker says out loud.
   */
  declared: boolean;
}

export function useProjects() {
  return useQuery({
    queryKey: ['execution', 'projects'],
    queryFn: async () => (await api.get<{ projects: ProjectOption[] }>('/execution/projects')).data.projects,
  });
}

export interface DiscoveredSuite {
  id: string;
  name: string;
  kind: 'tag' | 'feature';
  file?: string;
  fileCount?: number;
}

/**
 * Suites this project can actually run, read from its automation repo.
 *
 * `unavailable` is a normal answer, not an error: a project with no repo, or
 * one whose framework has no discovery adapter, simply can't be enumerated —
 * the form falls back to a text field and says why.
 */
export function useSuites(projectId: string | undefined) {
  return useQuery({
    queryKey: ['execution', 'suites', projectId],
    queryFn: async () =>
      (await api.get<{ suites: DiscoveredSuite[]; unavailable?: string }>(`/execution/projects/${projectId}/suites`))
        .data,
    enabled: Boolean(projectId),
    // Discovery clones or fetches a repo; re-running it because a component
    // remounted would make the form feel broken.
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/**
 * Real branch names for this project, straight from its git remote.
 *
 * Same `unavailable` shape as `useSuites`: a project with no `repoUrl`, or a
 * remote that can't be reached, simply can't be enumerated — the form falls
 * back to free text and says why, rather than blocking the trigger on it.
 */
export function useBranches(projectId: string | undefined) {
  return useQuery({
    queryKey: ['execution', 'branches', projectId],
    queryFn: async () =>
      (
        await api.get<{ branches: string[]; unavailable?: string }>(`/execution/projects/${projectId}/branches`)
      ).data,
    enabled: Boolean(projectId),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export interface TriggerRunInput {
  machineId: string;
  deviceUdid: string;
  project: string;
  branch: string;
  suite: string;
  setup?: { command: string; args: string[] };
  /**
   * Omit to use the project's configured run command. Only a project with no
   * automation config still requires one, which the backend rejects clearly.
   */
  run?: { command: string; args: string[] };
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

/**
 * Re-runs an existing run's immutable inputs (device, build, branch, suite)
 * as a brand-new trigger. The backend re-resolves config fresh rather than
 * replaying whatever the original run used — this is "run it again under
 * today's config," not "replay this exact past configuration."
 */
export function useRerunExecution(runId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => (await api.post<ExecutionRun>(`/execution/${runId}/rerun`)).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['runs'] });
      void qc.invalidateQueries({ queryKey: ['devices'] });
    },
  });
}

export interface ConfigReloadResult {
  reloaded: boolean;
  projects: { added: string[]; removed: string[]; total: number };
}

/**
 * Re-reads the org/project YAML on the hub.
 *
 * Lives beside the project query because that is the only place its effect is
 * visible: config was boot-only, so declaring a project meant restarting the
 * backend — which drops every live log stream and device capture with it.
 * Invalidates the project list on success so the dropdown updates without a
 * page reload, which is the whole point of the button.
 */
export function useReloadConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => (await api.post<ConfigReloadResult>('/config/reload', {})).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['execution', 'projects'] });
      // A changed automation repo changes what suites exist, so the cached
      // suite lists are stale too — they are keyed per project, hence the
      // prefix rather than one key.
      void qc.invalidateQueries({ queryKey: ['execution', 'suites'] });
    },
  });
}
