export interface DeviceBreakdown {
  deviceUdid: string;
  runs: number;
  passRate: number;
}

export interface SuiteBreakdown {
  suite: string;
  runs: number;
  passRate: number;
  flakiness: number;
}

export interface AnalyticsAggregate {
  _id: string;
  window: 'daily' | 'weekly';
  date: string;
  project: string;
  platform: 'android' | 'ios' | 'all';
  totalRuns: number;
  passedRuns: number;
  failedRuns: number;
  cancelledRuns: number;
  passRate: number;
  avgDurationMs: number;
  byDevice: DeviceBreakdown[];
  bySuite: SuiteBreakdown[];
  computedAt: string;
}
