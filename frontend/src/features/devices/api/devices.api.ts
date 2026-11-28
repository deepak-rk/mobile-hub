import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/services/api';
import { RETRY_WHILE_FAILING_MS } from '@/services/apiErrors';
import type { Device } from '../types';

export interface DeviceFilters {
  status?: string;
  platform?: string;
}

/**
 * Filters are forwarded to `GET /devices`'s own `status`/`platform` query
 * params rather than applied client-side — the backend already supports
 * them, so filtering there keeps one source of truth for "what matched"
 * instead of fetching everything and hiding rows in the browser.
 */
export function useDevices(filters: DeviceFilters = {}, options: { refetchInterval?: number } = {}) {
  const params = Object.fromEntries(Object.entries(filters).filter(([, v]) => v && v !== 'all'));
  return useQuery({
    queryKey: ['devices', params],
    queryFn: async () => (await api.get<Device[]>('/devices', { params })).data,
    // Off by default. Callers that must reflect state this client didn't cause
    // — a lock released when a run ends, the TTL sweep, another operator —
    // opt in, because those have no mutation here to invalidate on.
    // While failing (the hub restarting, say), keep trying so the page
    // recovers by itself instead of waiting for someone to press Retry.
    refetchInterval: (query) =>
      query.state.status === 'error' ? RETRY_WHILE_FAILING_MS : (options.refetchInterval ?? false),
  });
}

export function useDevice(udid: string | undefined, machineId?: string) {
  return useQuery({
    // machineId is part of the key: the same udid on two hosts is two devices.
    queryKey: ['devices', udid, machineId ?? null],
    queryFn: async () => (await api.get<Device>(`/devices/${udid}`, { params: machineId ? { machineId } : undefined })).data,
    enabled: Boolean(udid),
  });
}

/**
 * Acquire the device lock. Fails with 409 if someone already holds it.
 *
 * `machineId` disambiguates which host's device this is when the same UDID
 * could exist on more than one (routine for emulators) — optional so an
 * older caller keeps working, but every caller here has it on hand (the
 * `Device` object already carries it), so there's no reason not to send it.
 */
export function useLockDevice(udid: string, machineId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (reason?: string) => (await api.post<Device>(`/devices/${udid}/lock`, { reason, machineId })).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['devices'] });
    },
  });
}

/** Release the lock. The backend allows the holder, or any admin. See useLockDevice's note on `machineId`. */
export function useUnlockDevice(udid: string, machineId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => (await api.post<Device>(`/devices/${udid}/unlock`, { machineId })).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['devices'] });
    },
  });
}

/**
 * Renews a held lock's TTL clock (resets `acquiredAt` to now) without
 * changing anything else about it. Same owner-or-admin rule as unlock, same
 * `machineId` note as useLockDevice.
 */
export function useRenewLock(udid: string, machineId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => (await api.post<Device>(`/devices/${udid}/lock/renew`, { machineId })).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['devices'] });
    },
  });
}

/** Force-stops any live capture for this device (operator/admin only). */
export function useStopDeviceStream(udid: string, machineId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => (await api.post<{ stopped: number }>(`/devices/${udid}/stream/stop`, undefined, { params: machineId ? { machineId } : undefined })).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['devices'] });
    },
  });
}

/** What a person can ask a phone to do (the hub's `common/device-actions.ts`). */
export type DeviceAction =
  | { kind: 'key'; key: 'home' | 'back' | 'app_switch' | 'power' | 'volume_up' | 'volume_down' | 'enter' }
  | { kind: 'tap'; x: number; y: number }
  | { kind: 'swipe'; x1: number; y1: number; x2: number; y2: number; durationMs?: number }
  | { kind: 'text'; text: string }
  | { kind: 'rotate'; rotation: 0 | 1 | 2 | 3 }
  | { kind: 'reboot' };

export interface DeviceJob {
  _id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'timed_out' | 'interrupted';
  action: { kind: DeviceAction['kind'] } & Record<string, unknown>;
  output: string | null;
  error: string | null;
  late: boolean;
}

const JOB_POLL_MS = 250;
/** A little past the hub's claim + run timeouts, so the hub's verdict always arrives first. */
const JOB_WAIT_LIMIT_MS = 130_000;

/**
 * Sends one action and resolves with the finished job: the hub's record of
 * what the phone did, not merely that the request was accepted.
 */
export function useDeviceAction(udid: string, machineId?: string) {
  return useMutation({
    mutationFn: async (action: DeviceAction): Promise<DeviceJob> => {
      const created = (await api.post<DeviceJob>('/device-jobs', { deviceUdid: udid, machineId, action })).data;
      const deadline = Date.now() + JOB_WAIT_LIMIT_MS;
      let job = created;
      while ((job.status === 'queued' || job.status === 'running') && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, JOB_POLL_MS));
        job = (await api.get<DeviceJob>(`/device-jobs/${created._id}`)).data;
      }
      return job;
    },
  });
}

