import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/services/api';
import type { Device } from '../types';

export function useDevices() {
  return useQuery({
    queryKey: ['devices'],
    queryFn: async () => (await api.get<Device[]>('/devices')).data,
  });
}

export function useDevice(udid: string | undefined) {
  return useQuery({
    queryKey: ['devices', udid],
    queryFn: async () => (await api.get<Device>(`/devices/${udid}`)).data,
    enabled: Boolean(udid),
  });
}

/** Acquire the device lock. Fails with 409 if someone already holds it. */
export function useLockDevice(udid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (reason?: string) => (await api.post<Device>(`/devices/${udid}/lock`, { reason })).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['devices'] });
    },
  });
}

/** Release the lock. The backend allows the holder, or any admin. */
export function useUnlockDevice(udid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => (await api.post<Device>(`/devices/${udid}/unlock`)).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['devices'] });
    },
  });
}

/** Force-stops any live capture for this device (operator/admin only). */
export function useStopDeviceStream(udid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => (await api.post<{ stopped: number }>(`/devices/${udid}/stream/stop`)).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['devices'] });
    },
  });
}
