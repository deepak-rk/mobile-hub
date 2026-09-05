import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/services/api';
import type { InstallRun } from '../types';

const IN_FLIGHT: InstallRun['targets'][number]['status'][] = ['queued', 'downloading', 'transferring', 'installing'];

export function isTargetInFlight(status: InstallRun['targets'][number]['status']): boolean {
  return IN_FLIGHT.includes(status);
}

/** Polls only while at least one target hasn't reached a terminal state — same shape as useExecutionRun. */
export function useInstallRun(installRunId: string | undefined, livePush = false) {
  return useQuery({
    queryKey: ['device-installs', installRunId],
    queryFn: async () => (await api.get<InstallRun>(`/device-installs/${installRunId}`)).data,
    enabled: Boolean(installRunId),
    refetchInterval: (query) => {
      if (livePush) return false;
      return query.state.data?.targets.some((t) => isTargetInFlight(t.status)) ? 1000 : false;
    },
  });
}

export interface InstalledDevice {
  deviceUdid: string;
  /** Null when the device has since been deregistered or never synced. */
  deviceName: string | null;
  installRunId: string;
  installedAt: string | null;
}

/**
 * Devices that currently hold this build — "currently" meaning this build was
 * the last one successfully installed on them for its project, since a later
 * install of the same app replaces it. Derived entirely from install history;
 * the hub never asks the device what it is running.
 */
export function useInstalledDevices(buildId: string | undefined) {
  return useQuery({
    queryKey: ['device-installs', 'builds', buildId, 'devices'],
    queryFn: async () => (await api.get<InstalledDevice[]>(`/device-installs/builds/${buildId}/devices`)).data,
    enabled: Boolean(buildId),
  });
}

export interface TriggerInstallRunInput {
  buildId: string;
  deviceUdids: string[];
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
