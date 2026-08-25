import { useQuery } from '@tanstack/react-query';
import { api } from '@/services/api';
import type { Host } from '../types';

export function useHosts() {
  return useQuery({
    queryKey: ['hosts'],
    queryFn: async () => (await api.get<Host[]>('/hosts')).data,
  });
}
