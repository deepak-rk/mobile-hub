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

export interface DeviceUtilisation {
  deviceUdid: string;
  busyMs: number;
  windowMs: number;
  utilisation: number;
  runs: number;
}

type WindowParams = { project?: string; platform?: 'android' | 'ios' | 'all'; days?: number };

/** What fraction of the window each device spent busy vs idle — capacity planning, distinct from pass-rate. */
export function useDeviceUtilisation(params?: WindowParams) {
  return useQuery({
    queryKey: ['analytics', 'device-utilisation', params],
    queryFn: async () => (await api.get<DeviceUtilisation[]>('/analytics/device-utilisation', { params })).data,
  });
}

export interface ConfigTupleFlakiness {
  project: string;
  platform: 'android' | 'ios' | 'all';
  suite: string;
  suiteKind: 'tag' | 'feature' | 'name' | null;
  branch: string;
  runs: number;
  passRate: number;
  flakiness: number;
}

/** Flakiness grouped by suite+platform+branch as one unit — a specific branch/platform combination can be flaky while the suite overall looks stable. */
export function useConfigFlakiness(params?: WindowParams) {
  return useQuery({
    queryKey: ['analytics', 'flakiness', 'config', params],
    queryFn: async () => (await api.get<ConfigTupleFlakiness[]>('/analytics/flakiness/config', { params })).data,
  });
}

export interface TestCaseFlakiness {
  project: string;
  platform: 'android' | 'ios' | 'all';
  suite: string;
  branch: string;
  testId: string;
  testName: string;
  recentStatuses: string[];
  alternations: number;
}

/** Which one named test — not which suite or config — is alternating pass/fail across recent runs of the same configuration. */
export function useTestCaseFlakiness(params?: WindowParams) {
  return useQuery({
    queryKey: ['analytics', 'flakiness', 'tests', params],
    queryFn: async () => (await api.get<TestCaseFlakiness[]>('/analytics/flakiness/tests', { params })).data,
  });
}
