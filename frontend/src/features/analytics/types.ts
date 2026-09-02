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
  /**
   * Test-case-level totals, summed over the runs in this bucket that produced
   * Allure results — a different question from the run-level `passRate` above.
   * `runsWithTestResults` is what separates "everything failed" from "nothing
   * reported", since both leave `testPassRate` at 0.
   */
  totalTests: number;
  passedTests: number;
  testPassRate: number;
  runsWithTestResults: number;
  avgDurationMs: number;
  byDevice: DeviceBreakdown[];
  bySuite: SuiteBreakdown[];
  computedAt: string;
}
