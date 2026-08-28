import { describe, it, expect, vi, afterEach } from 'vitest';
import { ExecutionRun } from '../execution/execution-run.model';
import { Device } from '../devices/device.model';
import { AnalyticsAggregate } from './analytics-aggregate.model';
import { computeDailyAggregates, computeWeeklyAggregates, queryAggregates } from './analytics.service';

/**
 * Covers the three properties `computeDailyAggregates` exists for:
 * idempotent upsert (the unique index makes a recompute safe), a device that
 * no longer exists bucketing into the 'all'-platform rollup only, and every
 * project getting both its per-platform aggregates and an 'all' rollup.
 * Mongoose is stubbed; no database is used.
 */
type UpsertCall = [Record<string, unknown>, Record<string, unknown>, Record<string, unknown>];

function run(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    project: 'p1',
    deviceUdid: 'd1',
    suite: 'smoke',
    status: 'passed',
    startedAt: new Date('2026-01-01T00:00:00Z'),
    endedAt: new Date('2026-01-01T00:01:00Z'),
    ...overrides,
  };
}

/**
 * `history` is the trailing daily AnalyticsAggregate rows computeFlakinessBySuite
 * queries — defaults to none, matching every existing test's assumption
 * (no prior days on record, flakiness computed over whatever data exists).
 */
function stubRuns(
  runs: ReturnType<typeof run>[],
  devices: { udid: string; platform: string }[],
  history: Array<{ bySuite: Array<{ suite: string; passRate: number }> }> = [],
) {
  vi.spyOn(ExecutionRun, 'find').mockResolvedValue(runs as never);
  vi.spyOn(Device, 'find').mockReturnValue({
    select: () => Promise.resolve(devices),
  } as never);
  vi.spyOn(AnalyticsAggregate, 'find').mockReturnValue({
    select: () => Promise.resolve(history),
  } as never);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('computeDailyAggregates', () => {
  it('upserts on the (window, date, project, platform) key — recomputing is idempotent', async () => {
    stubRuns([run()], [{ udid: 'd1', platform: 'android' }]);
    const upsert = vi.fn().mockResolvedValue({ id: 'agg-1' });
    vi.spyOn(AnalyticsAggregate, 'findOneAndUpdate').mockImplementation(upsert as never);

    await computeDailyAggregates(new Date('2026-01-01T12:00:00Z'));

    const calls = upsert.mock.calls as UpsertCall[];
    for (const [filter, , options] of calls) {
      expect(filter).toMatchObject({ window: 'daily', project: 'p1' });
      expect(options).toMatchObject({ upsert: true, new: true });
    }
  });

  it('produces both the per-platform aggregate and an "all" rollup for a project', async () => {
    stubRuns([run()], [{ udid: 'd1', platform: 'android' }]);
    const upsert = vi.fn().mockResolvedValue({ id: 'agg' });
    vi.spyOn(AnalyticsAggregate, 'findOneAndUpdate').mockImplementation(upsert as never);

    await computeDailyAggregates(new Date('2026-01-01T12:00:00Z'));

    const calls = upsert.mock.calls as UpsertCall[];
    const platforms = calls.map(([filter]) => filter.platform);
    expect(platforms).toEqual(expect.arrayContaining(['android', 'all']));
  });

  it('a run whose device no longer exists buckets into "all" only, not a phantom platform', async () => {
    stubRuns([run({ deviceUdid: 'deleted-device' })], []); // Device.find returns nothing
    const upsert = vi.fn().mockResolvedValue({ id: 'agg' });
    vi.spyOn(AnalyticsAggregate, 'findOneAndUpdate').mockImplementation(upsert as never);

    await computeDailyAggregates(new Date('2026-01-01T12:00:00Z'));

    // Only one bucket written (the 'all' rollup) — no per-platform aggregate
    // for a device that isn't in inventory.
    expect(upsert).toHaveBeenCalledTimes(1);
    const [filter] = upsert.mock.calls[0] as UpsertCall;
    expect(filter.platform).toBe('all');
  });

  it('bucketing by endedAt queries the exact UTC day window', async () => {
    const findSpy = vi.spyOn(ExecutionRun, 'find').mockResolvedValue([] as never);
    vi.spyOn(Device, 'find').mockReturnValue({ select: () => Promise.resolve([]) } as never);

    await computeDailyAggregates(new Date('2026-03-15T18:30:00Z'));

    expect(findSpy).toHaveBeenCalledWith({
      status: { $in: ['passed', 'failed', 'cancelled'] },
      endedAt: { $gte: new Date('2026-03-15T00:00:00.000Z'), $lt: new Date('2026-03-16T00:00:00.000Z') },
    });
  });

  it('computes pass rate and average duration correctly across a mixed batch', async () => {
    stubRuns(
      [
        run({ status: 'passed' }),
        run({ status: 'failed', endedAt: new Date('2026-01-01T00:02:00Z') }),
        // A run rejected before it started: counted in totals, excluded from avgDurationMs.
        run({ status: 'failed', startedAt: null, endedAt: new Date('2026-01-01T00:00:30Z') }),
      ],
      [{ udid: 'd1', platform: 'android' }],
    );
    const upsert = vi.fn().mockResolvedValue({ id: 'agg' });
    vi.spyOn(AnalyticsAggregate, 'findOneAndUpdate').mockImplementation(upsert as never);

    await computeDailyAggregates(new Date('2026-01-01T12:00:00Z'));

    const calls = upsert.mock.calls as UpsertCall[];
    const androidCall = calls.find(([filter]) => filter.platform === 'android');
    const summary = androidCall?.[1];
    expect(summary?.totalRuns).toBe(3);
    expect(summary?.passedRuns).toBe(1);
    expect(summary?.passRate).toBeCloseTo(1 / 3);
    // Durations: run 1 = 60s, run 2 = 120s (its own endedAt override, default startedAt);
    // run 3 has no startedAt and is excluded. Average of the other two: 90s.
    expect(summary?.avgDurationMs).toBe(90000);
  });
});

describe('computeWeeklyAggregates', () => {
  it('upserts on the (window, date, project, platform) key with date pinned to the week\'s Monday', async () => {
    stubRuns([run()], [{ udid: 'd1', platform: 'android' }]);
    const upsert = vi.fn().mockResolvedValue({ id: 'agg-1' });
    vi.spyOn(AnalyticsAggregate, 'findOneAndUpdate').mockImplementation(upsert as never);

    // 2026-01-01 is a Thursday; that ISO week's Monday is 2025-12-29.
    await computeWeeklyAggregates(new Date('2026-01-01T12:00:00Z'));

    const calls = upsert.mock.calls as UpsertCall[];
    for (const [filter, , options] of calls) {
      expect(filter).toMatchObject({ window: 'weekly', date: new Date('2025-12-29T00:00:00.000Z'), project: 'p1' });
      expect(options).toMatchObject({ upsert: true, new: true });
    }
  });

  it('any day within the same ISO week resolves to the same Monday, including Sunday (the week\'s last day)', async () => {
    const findSpy = vi.spyOn(ExecutionRun, 'find').mockResolvedValue([] as never);
    vi.spyOn(Device, 'find').mockReturnValue({ select: () => Promise.resolve([]) } as never);

    // 2026-01-04 is the Sunday closing the same ISO week as 2026-01-01 above.
    await computeWeeklyAggregates(new Date('2026-01-04T23:00:00Z'));

    expect(findSpy).toHaveBeenCalledWith({
      status: { $in: ['passed', 'failed', 'cancelled'] },
      endedAt: { $gte: new Date('2025-12-29T00:00:00.000Z'), $lt: new Date('2026-01-05T00:00:00.000Z') },
    });
  });

  it('queries the full 7-day range, not a single day', async () => {
    const findSpy = vi.spyOn(ExecutionRun, 'find').mockResolvedValue([] as never);
    vi.spyOn(Device, 'find').mockReturnValue({ select: () => Promise.resolve([]) } as never);

    await computeWeeklyAggregates(new Date('2026-03-18T12:00:00Z')); // a Wednesday

    const [{ endedAt }] = findSpy.mock.calls[0] as unknown as [{ endedAt: { $gte: Date; $lt: Date } }];
    const spanMs = endedAt.$lt.getTime() - endedAt.$gte.getTime();
    expect(spanMs).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('produces both the per-platform aggregate and an "all" rollup, same as daily', async () => {
    stubRuns([run()], [{ udid: 'd1', platform: 'android' }]);
    const upsert = vi.fn().mockResolvedValue({ id: 'agg' });
    vi.spyOn(AnalyticsAggregate, 'findOneAndUpdate').mockImplementation(upsert as never);

    await computeWeeklyAggregates(new Date('2026-01-01T12:00:00Z'));

    const calls = upsert.mock.calls as UpsertCall[];
    const platforms = calls.map(([filter]) => filter.platform);
    expect(platforms).toEqual(expect.arrayContaining(['android', 'all']));
  });

  it('is idempotent — recomputing the same week upserts the same key, not a duplicate row', async () => {
    stubRuns([run()], [{ udid: 'd1', platform: 'android' }]);
    const upsert = vi.fn().mockResolvedValue({ id: 'agg' });
    vi.spyOn(AnalyticsAggregate, 'findOneAndUpdate').mockImplementation(upsert as never);

    await computeWeeklyAggregates(new Date('2026-01-01T12:00:00Z'));
    const firstCallKeys = (upsert.mock.calls as UpsertCall[]).map(([filter]) => filter);
    upsert.mockClear();

    await computeWeeklyAggregates(new Date('2026-01-02T09:00:00Z')); // a different day, same week
    const secondCallKeys = (upsert.mock.calls as UpsertCall[]).map(([filter]) => filter);

    expect(secondCallKeys).toEqual(firstCallKeys);
  });
});

describe('flakiness (docs/competitive-analysis.md §4f: stddev of daily pass rate over a trailing window)', () => {
  it('scores 0 for a suite that is consistently green across the trailing history', async () => {
    stubRuns([run({ status: 'passed' })], [{ udid: 'd1', platform: 'android' }], [
      { bySuite: [{ suite: 'smoke', passRate: 1 }] },
      { bySuite: [{ suite: 'smoke', passRate: 1 }] },
      { bySuite: [{ suite: 'smoke', passRate: 1 }] },
    ]);
    const upsert = vi.fn().mockResolvedValue({ id: 'agg' });
    vi.spyOn(AnalyticsAggregate, 'findOneAndUpdate').mockImplementation(upsert as never);

    await computeDailyAggregates(new Date('2026-01-01T12:00:00Z'));

    const calls = upsert.mock.calls as UpsertCall[];
    const androidCall = calls.find(([filter]) => filter.platform === 'android');
    const summary = androidCall?.[1] as { bySuite: Array<{ suite: string; flakiness: number }> };
    expect(summary.bySuite.find((s) => s.suite === 'smoke')?.flakiness).toBe(0);
  });

  it('scores above 0 for a suite alternating pass/fail across the trailing history', async () => {
    stubRuns([run({ status: 'passed' })], [{ udid: 'd1', platform: 'android' }], [
      { bySuite: [{ suite: 'smoke', passRate: 1 }] },
      { bySuite: [{ suite: 'smoke', passRate: 0 }] },
      { bySuite: [{ suite: 'smoke', passRate: 1 }] },
    ]);
    const upsert = vi.fn().mockResolvedValue({ id: 'agg' });
    vi.spyOn(AnalyticsAggregate, 'findOneAndUpdate').mockImplementation(upsert as never);

    await computeDailyAggregates(new Date('2026-01-01T12:00:00Z'));

    const calls = upsert.mock.calls as UpsertCall[];
    const androidCall = calls.find(([filter]) => filter.platform === 'android');
    const summary = androidCall?.[1] as { bySuite: Array<{ suite: string; flakiness: number }> };
    expect(summary.bySuite.find((s) => s.suite === 'smoke')?.flakiness).toBeGreaterThan(0);
  });

  it('folds in the fresh (not-yet-persisted) rate for today, not just prior history', async () => {
    // No prior history at all — today's own run is the only data point.
    // A single point has no measurable variance, so flakiness reads 0
    // (honest "not enough data yet"), not NaN.
    stubRuns([run({ status: 'passed' })], [{ udid: 'd1', platform: 'android' }], []);
    const upsert = vi.fn().mockResolvedValue({ id: 'agg' });
    vi.spyOn(AnalyticsAggregate, 'findOneAndUpdate').mockImplementation(upsert as never);

    await computeDailyAggregates(new Date('2026-01-01T12:00:00Z'));

    const calls = upsert.mock.calls as UpsertCall[];
    const androidCall = calls.find(([filter]) => filter.platform === 'android');
    const summary = androidCall?.[1] as { bySuite: Array<{ suite: string; flakiness: number }> };
    expect(summary.bySuite.find((s) => s.suite === 'smoke')?.flakiness).toBe(0);
  });

  it('a suite with no runs at all in the trailing window is simply absent, not NaN', async () => {
    stubRuns([], [], []);
    const upsert = vi.fn().mockResolvedValue({ id: 'agg' });
    vi.spyOn(AnalyticsAggregate, 'findOneAndUpdate').mockImplementation(upsert as never);

    await computeDailyAggregates(new Date('2026-01-01T12:00:00Z'));

    expect(upsert).not.toHaveBeenCalled(); // no runs at all -> no projects -> no buckets written
  });

  it('a weekly bucket uses only real trailing daily history, not a fabricated "this week" data point', async () => {
    stubRuns([run({ status: 'passed' })], [{ udid: 'd1', platform: 'android' }], [
      { bySuite: [{ suite: 'smoke', passRate: 0.5 }] },
      { bySuite: [{ suite: 'smoke', passRate: 0.5 }] },
    ]);
    const upsert = vi.fn().mockResolvedValue({ id: 'agg' });
    vi.spyOn(AnalyticsAggregate, 'findOneAndUpdate').mockImplementation(upsert as never);

    await computeWeeklyAggregates(new Date('2026-01-01T12:00:00Z'));

    const calls = upsert.mock.calls as UpsertCall[];
    const androidCall = calls.find(([filter]) => filter.platform === 'android');
    const summary = androidCall?.[1] as { bySuite: Array<{ suite: string; flakiness: number }> };
    // Constant 0.5 history -> 0 variance, regardless of this week's own (unused) pass rate.
    expect(summary.bySuite.find((s) => s.suite === 'smoke')?.flakiness).toBe(0);
  });
});

describe('queryAggregates', () => {
  it('applies only the filters that were actually provided', async () => {
    const sort = vi.fn().mockResolvedValue([]);
    const findSpy = vi.spyOn(AnalyticsAggregate, 'find').mockReturnValue({ sort } as never);

    await queryAggregates({ project: 'p1' });

    expect(findSpy).toHaveBeenCalledWith({ project: 'p1' });
  });

  it('builds a $gte/$lte date range from from/to, normalized to UTC day start', async () => {
    const sort = vi.fn().mockResolvedValue([]);
    const findSpy = vi.spyOn(AnalyticsAggregate, 'find').mockReturnValue({ sort } as never);

    await queryAggregates({ from: new Date('2026-01-01T18:00:00Z'), to: new Date('2026-01-05T03:00:00Z') });

    expect(findSpy).toHaveBeenCalledWith({
      date: { $gte: new Date('2026-01-01T00:00:00.000Z'), $lte: new Date('2026-01-05T00:00:00.000Z') },
    });
  });
});
