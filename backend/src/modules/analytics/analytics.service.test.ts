import { describe, it, expect, vi, afterEach } from 'vitest';
import { ExecutionRun } from '../execution/execution-run.model';
import { Device } from '../devices/device.model';
import { AnalyticsAggregate } from './analytics-aggregate.model';
import { computeDailyAggregates, queryAggregates } from './analytics.service';

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

function stubRuns(runs: ReturnType<typeof run>[], devices: { udid: string; platform: string }[]) {
  vi.spyOn(ExecutionRun, 'find').mockResolvedValue(runs as never);
  vi.spyOn(Device, 'find').mockReturnValue({
    select: () => Promise.resolve(devices),
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
