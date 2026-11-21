export interface DeviceBreakdown {
  /**
   * The device's host. Device identity is machineId + udid (emulator serials
   * repeat on every host). Absent on aggregates stored before it was added.
   */
  machineId?: string;
  deviceUdid: string;
  runs: number;
  passRate: number;
}

export interface SuiteBreakdown {
  suite: string;
  /**
   * How the suite was addressed. A Cucumber tag and a feature path select
   * different test sets, so they are separate rows even when they share a
   * name — which is why the table has to show this. Absent on rows aggregated
   * before it was recorded.
   */
  suiteKind?: 'tag' | 'feature' | 'name' | null;
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
