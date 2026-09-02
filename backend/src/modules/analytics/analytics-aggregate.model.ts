import { Schema, model, Document } from 'mongoose';

export interface IAnalyticsAggregate extends Document {
  window: 'daily' | 'weekly';
  date: Date;
  project: string;
  platform: 'android' | 'ios' | 'all';
  totalRuns: number;
  passedRuns: number;
  failedRuns: number;
  cancelledRuns: number;
  passRate: number;
  /**
   * Test-case-level totals, summed over the runs in this bucket that produced
   * Allure results. Separate from the run-level counts above because they
   * answer a different question — a run with 143/145 passing is one failed run
   * and 143 passed tests.
   */
  totalTests: number;
  passedTests: number;
  testPassRate: number;
  /** How many runs contributed to the two above — the rest reported no tests. */
  runsWithTestResults: number;
  avgDurationMs: number;
  byDevice: Array<{ deviceUdid: string; runs: number; passRate: number }>;
  /**
   * `suiteKind` is how the suite was addressed — a Cucumber tag and a feature
   * path select different test sets, so they are bucketed separately even
   * when they share a name. Optional: rows written before it existed have no
   * value, and those key on the bare name, which is what they were bucketed
   * as.
   */
  bySuite: Array<{
    suite: string;
    suiteKind?: 'tag' | 'feature' | 'name' | null;
    runs: number;
    passRate: number;
    flakiness: number;
  }>;
  computedAt: Date;
}

const analyticsAggregateSchema = new Schema<IAnalyticsAggregate>(
  {
    window: { type: String, enum: ['daily', 'weekly'], required: true },
    date: { type: Date, required: true },
    project: { type: String, required: true },
    platform: { type: String, enum: ['android', 'ios', 'all'], required: true },
    totalRuns: { type: Number, default: 0 },
    passedRuns: { type: Number, default: 0 },
    failedRuns: { type: Number, default: 0 },
    cancelledRuns: { type: Number, default: 0 },
    passRate: { type: Number, default: 0 },
    totalTests: { type: Number, default: 0 },
    passedTests: { type: Number, default: 0 },
    testPassRate: { type: Number, default: 0 },
    runsWithTestResults: { type: Number, default: 0 },
    avgDurationMs: { type: Number, default: 0 },
    byDevice: [{ deviceUdid: String, runs: Number, passRate: Number }],
    bySuite: [{ suite: String, suiteKind: String, runs: Number, passRate: Number, flakiness: Number }],
    computedAt: { type: Date, default: Date.now },
  },
  { timestamps: false },
);

analyticsAggregateSchema.index({ window: 1, date: 1, project: 1, platform: 1 }, { unique: true });

export const AnalyticsAggregate = model<IAnalyticsAggregate>('AnalyticsAggregate', analyticsAggregateSchema);
