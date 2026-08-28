import { useQuery } from '@tanstack/react-query';
import { api } from '@/services/api';
import type { AnalyticsAggregate } from '../types';

export function useAnalytics(params?: {
  project?: string;
  platform?: 'android' | 'ios' | 'all';
  window?: 'daily' | 'weekly';
}) {
  return useQuery({
    queryKey: ['analytics', params],
    queryFn: async () => (await api.get<AnalyticsAggregate[]>('/analytics', { params })).data,
  });
}
