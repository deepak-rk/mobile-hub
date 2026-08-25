import { useQuery } from '@tanstack/react-query';
import { api } from '@/services/api';
import type { Build } from '../types';

export function useBuilds() {
  return useQuery({
    queryKey: ['builds'],
    queryFn: async () => (await api.get<Build[]>('/builds')).data,
  });
}
