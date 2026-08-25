import { useQuery } from '@tanstack/react-query';
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
