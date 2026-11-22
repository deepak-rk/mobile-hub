import { useMutation, useQueries, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api } from '@/services/api';
import type { InstallRun } from '../types';

const IN_FLIGHT: InstallRun['targets'][number]['status'][] = [
  'queued',
  'downloading',
  'transferring',
  'installing',
  'granting-permissions',
];

export function isTargetInFlight(status: InstallRun['targets'][number]['status']): boolean {
  return IN_FLIGHT.includes(status);
}

/** The query-key prefix every useInstalledDevices list sits under. */
const INSTALLED_DEVICES_KEY = ['device-installs', 'builds'];

/**
 * Called whenever a fresh install/uninstall run record arrives. The
 * "Installed on" list is derived from *finished* runs, so it can only change
 * once a run is terminal — invalidating when the trigger is merely accepted
 * (what the mutations do) refetches before the agent has done anything, and
 * nothing refetched it afterwards. This is the "afterwards".
 */
function refreshInstalledIfSettled(qc: QueryClient, statuses: string[]) {
  if (statuses.every((s) => s === 'done' || s === 'error')) {
    void qc.invalidateQueries({ queryKey: INSTALLED_DEVICES_KEY });
  }
}

/** Polls only while at least one target hasn't reached a terminal state — same shape as useExecutionRun. */
export function useInstallRun(installRunId: string | undefined, livePush = false) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: ['device-installs', installRunId],
    queryFn: async () => {
      const run = (await api.get<InstallRun>(`/device-installs/${installRunId}`)).data;
      // Covers the live-push path too: each WS event invalidates this query,
      // so the terminal event's refetch lands here.
      refreshInstalledIfSettled(qc, run.targets.map((t) => t.status));
      return run;
    },
    enabled: Boolean(installRunId),
    refetchInterval: (query) => {
      if (livePush) return false;
      return query.state.data?.targets.some((t) => isTargetInFlight(t.status)) ? 1000 : false;
    },
  });
}

export interface InstalledDevice {
  deviceUdid: string;
  /** The host the device is attached to; send it back when acting on the device. */
  machineId: string;
  /** Null when the device has since been deregistered or never synced. */
  deviceName: string | null;
  installRunId: string;
  installedAt: string | null;
  /** Null for a run predating this field, or a same-version reinstall the agent couldn't positively attribute — nothing to uninstall from here. */
  packageName: string | null;
  /** A non-fatal note from the install (unverified, or permissions not granted); null/absent when clean. */
  note?: string | null;
}

/**
 * Devices that currently hold this build — "currently" meaning this build was
 * the last one successfully installed on them for its project, since a later
 * install of the same app replaces it. Derived entirely from install history;
 * the hub never asks the device what it is running.
 */
export function useInstalledDevices(buildId: string | undefined) {
  return useQuery({
    queryKey: [...INSTALLED_DEVICES_KEY, buildId, 'devices'],
    queryFn: async () => (await api.get<InstalledDevice[]>(`/device-installs/builds/${buildId}/devices`)).data,
    enabled: Boolean(buildId),
  });
}

/** A device on a specific host — emulator serials repeat across hosts. */
export interface DeviceRef {
  udid: string;
  machineId: string;
}

export interface TriggerInstallRunInput {
  buildId: string;
  devices: DeviceRef[];
}

export function useTriggerInstallRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: TriggerInstallRunInput) => (await api.post<InstallRun>('/device-installs', input)).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['device-installs'] });
    },
  });
}

export interface TriggerUninstallRunInput {
  packageName: string;
  project: string;
  devices: DeviceRef[];
}

/**
 * Removes a package from one device — the reverse of triggerInstallRun, and
 * deliberately a single-device call from the UI even though the backend
 * accepts many at once: the one call site (a per-device row in
 * BuildDetailDialog's "Installed on" list) only ever has one device in hand.
 */
export function useTriggerUninstallRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: TriggerUninstallRunInput) =>
      (await api.post<UninstallRun>('/device-installs/uninstalls', input)).data,
    onSuccess: () => {
      // Only "accepted" — the agent hasn't uninstalled anything yet, so this
      // alone does not drop the device from the "Installed on" list. Watch
      // the returned run with useUninstallRuns for that.
      void qc.invalidateQueries({ queryKey: ['device-installs'] });
    },
  });
}

export interface UninstallRun {
  _id: string;
  targets: { deviceUdid: string; machineId: string; status: 'queued' | 'uninstalling' | 'done' | 'error' }[];
}

/**
 * Polls each uninstall run until every target is terminal, then refreshes
 * the "Installed on" list (see refreshInstalledIfSettled). Several at once
 * because a user can uninstall from a second device before the first ends.
 */
export function useUninstallRuns(uninstallRunIds: string[]) {
  const qc = useQueryClient();
  return useQueries({
    queries: uninstallRunIds.map((id) => ({
      queryKey: ['device-installs', 'uninstalls', id],
      queryFn: async () => {
        const run = (await api.get<UninstallRun>(`/device-installs/uninstalls/${id}`)).data;
        refreshInstalledIfSettled(qc, run.targets.map((t) => t.status));
        return run;
      },
      refetchInterval: (query: { state: { data?: UninstallRun } }) =>
        query.state.data?.targets.every((t) => t.status === 'done' || t.status === 'error') ? false : 1000,
    })),
  });
}
