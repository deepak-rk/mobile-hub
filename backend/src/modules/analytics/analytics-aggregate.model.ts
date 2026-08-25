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
  avgDurationMs: number;
  byDevice: Array<{ deviceUdid: string; runs: number; passRate: number }>;
  bySuite: Array<{ suite: string; runs: number; passRate: number; flakiness: number }>;
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
    avgDurationMs: { type: Number, default: 0 },
    byDevice: [{ deviceUdid: String, runs: Number, passRate: Number }],
    bySuite: [{ suite: String, runs: Number, passRate: Number, flakiness: Number }],
    computedAt: { type: Date, default: Date.now },
  },
  { timestamps: false },
);

analyticsAggregateSchema.index({ window: 1, date: 1, project: 1, platform: 1 }, { unique: true });

export const AnalyticsAggregate = model<IAnalyticsAggregate>('AnalyticsAggregate', analyticsAggregateSchema);
