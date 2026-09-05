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

export interface FailureReasonSummary {
  signature: string;
  message: string;
  count: number;
  runCount: number;
  lastSeenAt: string;
}

/**
 * "What fails repeatedly" across a trailing window — distinct from a single
 * run's own failure breakdown (RunDetailPage), which only answers "what
 * failed on this run".
 */
export function useFailureReasons(params?: { project?: string; platform?: 'android' | 'ios' | 'all'; suite?: string }) {
  return useQuery({
    queryKey: ['analytics', 'failures', params],
    queryFn: async () =>
      (await api.get<{ reasons: FailureReasonSummary[]; scannedRuns: number }>('/analytics/failures', { params }))
        .data,
  });
}
