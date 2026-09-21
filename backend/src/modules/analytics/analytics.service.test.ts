import { describe, it, expect, vi, afterEach } from 'vitest';
import { ExecutionRun } from '../execution/execution-run.model';
import { Device } from '../devices/device.model';
import { AnalyticsAggregate } from './analytics-aggregate.model';
import {
  computeDailyAggregates,
  computeWeeklyAggregates,
  queryAggregates,
  computeFailureReasons,
  normalizeFailureMessage,
  computeDeviceUtilisation,
  computeFlakinessByConfigTuple,
  computeTestCaseFlakiness,
} from './analytics.service';

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

  it('reports a test-level pass rate alongside the run-level one, which can differ wildly', async () => {
    stubRuns(
      [
        // One failed run — 0% at run level — that passed 143 of its 145 tests.
        // Before this existed, that was indistinguishable from a suite where
        // all 145 failed.
        run({
          status: 'failed',
          failureKind: 'test',
          testSummary: { total: 145, passed: 143, failed: 2, broken: 0, skipped: 0, unknown: 0, passRate: 143 / 145 },
        }),
      ],
      [{ udid: 'd1', platform: 'android' }],
    );
    const upsert = vi.fn().mockResolvedValue({ id: 'agg' });
    vi.spyOn(AnalyticsAggregate, 'findOneAndUpdate').mockImplementation(upsert as never);

    await computeDailyAggregates(new Date('2026-01-01T12:00:00Z'));

    const calls = upsert.mock.calls as UpsertCall[];
    const summary = calls.find(([filter]) => filter.platform === 'android')?.[1];
    expect(summary?.passRate).toBe(0);
    expect(summary?.totalTests).toBe(145);
    expect(summary?.passedTests).toBe(143);
    expect(summary?.testPassRate).toBeCloseTo(0.986, 3);
    expect(summary?.runsWithTestResults).toBe(1);
  });

  it('excludes runs that reported no tests from the test-level denominator', async () => {
    stubRuns(
      [
        run({ testSummary: { total: 10, passed: 8, failed: 2, broken: 0, skipped: 0, unknown: 0, passRate: 0.8 } }),
        // A project not using Allure. Counting it as 0 tests passed of 0 would
        // be harmless; counting it as a run that failed to report would drag
        // every rate toward zero.
        run({ testSummary: null }),
      ],
      [{ udid: 'd1', platform: 'android' }],
    );
    const upsert = vi.fn().mockResolvedValue({ id: 'agg' });
    vi.spyOn(AnalyticsAggregate, 'findOneAndUpdate').mockImplementation(upsert as never);

    await computeDailyAggregates(new Date('2026-01-01T12:00:00Z'));

    const calls = upsert.mock.calls as UpsertCall[];
    const summary = calls.find(([filter]) => filter.platform === 'android')?.[1];
    expect(summary?.totalRuns).toBe(2);
    // Only the reporting run contributes, so the rate is its own 8/10 — not
    // 8/10 diluted by a run that never had tests to count.
    expect(summary?.runsWithTestResults).toBe(1);
    expect(summary?.totalTests).toBe(10);
    expect(summary?.testPassRate).toBe(0.8);
  });

  it('reads platform from the run snapshot, so deleting a device cannot rewrite history', async () => {
    // The device is gone from inventory entirely — the live join this used to
    // rely on would resolve it to 'all' and quietly unattribute a run that was
    // unambiguously Android when it happened.
    stubRuns([run({ snapshot: { platform: 'android', suiteKind: 'feature' } })], []);
    const upsert = vi.fn().mockResolvedValue({ id: 'agg' });
    vi.spyOn(AnalyticsAggregate, 'findOneAndUpdate').mockImplementation(upsert as never);

    await computeDailyAggregates(new Date('2026-01-01T12:00:00Z'));

    const platforms = (upsert.mock.calls as UpsertCall[]).map(([filter]) => filter.platform);
    expect(platforms).toContain('android');
  });

  it('still joins the device for runs predating the snapshot', async () => {
    // Back-filling a snapshot for these would be a guess dressed as a fact, so
    // they keep the old behaviour rather than losing their platform.
    stubRuns([run({ snapshot: null })], [{ udid: 'd1', platform: 'ios' }]);
    const upsert = vi.fn().mockResolvedValue({ id: 'agg' });
    vi.spyOn(AnalyticsAggregate, 'findOneAndUpdate').mockImplementation(upsert as never);

    await computeDailyAggregates(new Date('2026-01-01T12:00:00Z'));

    const platforms = (upsert.mock.calls as UpsertCall[]).map(([filter]) => filter.platform);
    expect(platforms).toContain('ios');
  });

  it('buckets a tag and a feature path separately even when they share a name', async () => {
    // The two select different sets of tests, so pooling their pass rates into
    // one series is what made flakiness — a variance measure over that series —
    // untrustworthy.
    stubRuns(
      [
        run({ suite: 'login', snapshot: { platform: 'android', suiteKind: 'tag' }, status: 'passed' }),
        run({ suite: 'login', snapshot: { platform: 'android', suiteKind: 'feature' }, status: 'failed', failureKind: 'test' }),
      ],
      [{ udid: 'd1', platform: 'android' }],
    );
    const upsert = vi.fn().mockResolvedValue({ id: 'agg' });
    vi.spyOn(AnalyticsAggregate, 'findOneAndUpdate').mockImplementation(upsert as never);

    await computeDailyAggregates(new Date('2026-01-01T12:00:00Z'));

    const calls = upsert.mock.calls as UpsertCall[];
    const summary = calls.find(([filter]) => filter.platform === 'android')?.[1];
    const bySuite = summary?.bySuite as Array<{ suite: string; suiteKind: string; passRate: number }>;
    expect(bySuite).toHaveLength(2);
    // Reported with the bare name, because the UI links a suite row to
    // /execution?suite=<suite>, which filters on what the run actually stored.
    expect(bySuite.every((b) => b.suite === 'login')).toBe(true);
    expect(bySuite.map((b) => b.suiteKind).sort()).toEqual(['feature', 'tag']);
    // Two separate 1-run buckets, not one bucket averaging to 50%.
    expect(bySuite.map((b) => b.passRate).sort()).toEqual([0, 1]);
  });

  it('keeps a pre-snapshot run in the same bucket as a post-snapshot one for the same suite', async () => {
    // The regression this guards: falling back to null instead of classifying
    // split one feature file into two rows — an unqualified bucket holding its
    // history and a qualified one starting from zero — which was visible in a
    // real aggregate. `classifySuite` is a pure function of the string and the
    // same one the runner used, so it recovers the kind rather than guessing.
    stubRuns(
      [
        run({ suite: 'test/features/login.feature', snapshot: null }),
        run({ suite: 'test/features/login.feature', snapshot: { platform: 'android', suiteKind: 'feature' } }),
      ],
      [{ udid: 'd1', platform: 'android' }],
    );
    const upsert = vi.fn().mockResolvedValue({ id: 'agg' });
    vi.spyOn(AnalyticsAggregate, 'findOneAndUpdate').mockImplementation(upsert as never);

    await computeDailyAggregates(new Date('2026-01-01T12:00:00Z'));

    const calls = upsert.mock.calls as UpsertCall[];
    const summary = calls.find(([filter]) => filter.platform === 'android')?.[1];
    const bySuite = summary?.bySuite as Array<{ suite: string; suiteKind: string; runs: number }>;
    expect(bySuite).toEqual([
      expect.objectContaining({ suite: 'test/features/login.feature', suiteKind: 'feature', runs: 2 }),
    ]);
  });

  it('leaves the test-level rate at zero when nothing reported results', async () => {
    stubRuns([run()], [{ udid: 'd1', platform: 'android' }]);
    const upsert = vi.fn().mockResolvedValue({ id: 'agg' });
    vi.spyOn(AnalyticsAggregate, 'findOneAndUpdate').mockImplementation(upsert as never);

    await computeDailyAggregates(new Date('2026-01-01T12:00:00Z'));

    const calls = upsert.mock.calls as UpsertCall[];
    const summary = calls.find(([filter]) => filter.platform === 'android')?.[1];
    // Zero, same as passRate handles an empty denominator — and
    // runsWithTestResults is what tells "all failed" from "nothing reported".
    expect(summary?.testPassRate).toBe(0);
    expect(summary?.runsWithTestResults).toBe(0);
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

describe('normalizeFailureMessage', () => {
  it('collapses messages that differ only in volatile values (ids, ports, counts) to the same signature', () => {
    const a = normalizeFailureMessage('Timeout waiting for element after 5000ms on port 4723 (run 6a9433ff6a37c7fb88c9fe15)');
    const b = normalizeFailureMessage('Timeout waiting for element after 8000ms on port 4801 (run 6a9433ff6a37c7fb88c9fe16)');
    expect(a).toBe(b);
  });

  it('keeps messages that actually differ in wording apart', () => {
    const a = normalizeFailureMessage('expected true to be false');
    const b = normalizeFailureMessage('element not found: #submit');
    expect(a).not.toBe(b);
  });
});

describe('computeFailureReasons', () => {
  function mockRuns(runs: unknown[]) {
    const lean = vi.fn().mockResolvedValue(runs);
    const sort = vi.fn().mockReturnValue({ lean });
    const select = vi.fn().mockReturnValue({ sort });
    return vi.spyOn(ExecutionRun, 'find').mockReturnValue({ select } as never);
  }

  it('groups failures across runs by normalized message and counts both tests and distinct runs', async () => {
    mockRuns([
      {
        createdAt: new Date('2026-01-01'),
        snapshot: { platform: 'android' },
        testSummary: { failures: [{ message: 'Timeout after 5000ms', count: 2 }] },
      },
      {
        createdAt: new Date('2026-01-02'),
        snapshot: { platform: 'android' },
        testSummary: { failures: [{ message: 'Timeout after 8000ms', count: 3 }] },
      },
    ]);

    const { reasons, scannedRuns } = await computeFailureReasons({});

    expect(scannedRuns).toBe(2);
    expect(reasons).toEqual([
      {
        signature: normalizeFailureMessage('Timeout after 5000ms'),
        message: 'Timeout after 5000ms', // first occurrence's real message, for display
        count: 5, // 2 + 3 tests, not 2 runs
        runCount: 2,
        lastSeenAt: new Date('2026-01-02'), // the later run, since runs are scanned oldest-first
      },
    ]);
  });

  it('orders reasons by how many tests they hit, worst first', async () => {
    mockRuns([
      {
        createdAt: new Date('2026-01-01'),
        snapshot: { platform: 'android' },
        testSummary: {
          failures: [
            { message: 'rare failure', count: 1 },
            { message: 'common failure', count: 20 },
          ],
        },
      },
    ]);

    const { reasons } = await computeFailureReasons({});

    expect(reasons.map((r) => r.message)).toEqual(['common failure', 'rare failure']);
  });

  it('excludes a run predating the platform snapshot when a platform filter is requested, rather than guessing', async () => {
    mockRuns([
      {
        createdAt: new Date('2026-01-01'),
        snapshot: null, // predates ExecutionRun.snapshot
        testSummary: { failures: [{ message: 'old-run failure', count: 1 }] },
      },
      {
        createdAt: new Date('2026-01-02'),
        snapshot: { platform: 'android' },
        testSummary: { failures: [{ message: 'known-platform failure', count: 1 }] },
      },
    ]);

    const { reasons, scannedRuns } = await computeFailureReasons({ platform: 'android' });

    expect(scannedRuns).toBe(1);
    expect(reasons.map((r) => r.message)).toEqual(['known-platform failure']);
  });

  it('queries only runs with at least one failure, within the requested trailing window', async () => {
    const findSpy = mockRuns([]);

    await computeFailureReasons({ project: 'p1', suite: 'smoke', days: 7 });

    const [calledWith] = findSpy.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(calledWith).toMatchObject({
      project: 'p1',
      suite: 'smoke',
      'testSummary.failures.0': { $exists: true },
    });
    expect((calledWith.createdAt as { $gte: Date }).$gte.getTime()).toBeLessThan(Date.now());
  });
});

/** `.select(...).lean()` chain, shared by computeDeviceUtilisation and computeFlakinessByConfigTuple. */
function mockLeanRuns(runs: unknown[]) {
  const lean = vi.fn().mockResolvedValue(runs);
  const select = vi.fn().mockReturnValue({ lean });
  return vi.spyOn(ExecutionRun, 'find').mockReturnValue({ select } as never);
}

describe('computeDeviceUtilisation', () => {
  it('sums each device\'s busy time as a fraction of the window', async () => {
    const now = Date.now();
    mockLeanRuns([
      {
        deviceUdid: 'd1',
        startedAt: new Date(now - 60_000),
        endedAt: new Date(now - 30_000), // 30s busy
        snapshot: { platform: 'android' },
      },
      {
        deviceUdid: 'd2',
        startedAt: new Date(now - 60_000),
        endedAt: new Date(now), // 60s busy
        snapshot: { platform: 'android' },
      },
    ]);

    const result = await computeDeviceUtilisation({ days: 1 });

    const d2 = result.find((r) => r.deviceUdid === 'd2')!;
    const d1 = result.find((r) => r.deviceUdid === 'd1')!;
    expect(d2.busyMs).toBe(60_000);
    expect(d1.busyMs).toBe(30_000);
    // Sorted by utilisation descending — the busier device first.
    expect(result[0].deviceUdid).toBe('d2');
  });

  it('excludes a run still in flight (no endedAt) rather than counting a partial window', async () => {
    mockLeanRuns([{ deviceUdid: 'd1', startedAt: new Date(), endedAt: null, snapshot: { platform: 'android' } }]);

    const result = await computeDeviceUtilisation({});

    expect(result).toEqual([]);
  });

  it('caps utilisation at 1 rather than reading above 100%', async () => {
    const now = Date.now();
    // A window far longer than the "busy" duration below would normally give
    // a tiny fraction — construct the opposite (busy duration exceeding the
    // requested window) to prove the cap holds even though the lock model
    // should make this unreachable in practice.
    mockLeanRuns([
      {
        deviceUdid: 'd1',
        startedAt: new Date(now - 10 * 24 * 60 * 60 * 1000),
        endedAt: new Date(now),
        snapshot: { platform: 'android' },
      },
    ]);

    const result = await computeDeviceUtilisation({ days: 1 });

    expect(result[0].utilisation).toBe(1);
  });

  it('excludes a device once a platform filter is applied and its runs predate the snapshot', async () => {
    mockLeanRuns([
      { deviceUdid: 'd1', startedAt: new Date(), endedAt: new Date(), snapshot: null },
    ]);

    const result = await computeDeviceUtilisation({ platform: 'android' });

    expect(result).toEqual([]);
  });
});

describe('computeFlakinessByConfigTuple', () => {
  it('scores a config tuple whose daily pass rate varies as flaky, and a consistently green one as 0', async () => {
    mockLeanRuns([
      // suite A on 'main': alternates day to day.
      { project: 'p1', branch: 'main', suite: 'smoke', status: 'passed', failureKind: null, endedAt: new Date('2026-01-01T01:00:00Z'), snapshot: { platform: 'android', suiteKind: 'name' } },
      { project: 'p1', branch: 'main', suite: 'smoke', status: 'failed', failureKind: 'test', endedAt: new Date('2026-01-02T01:00:00Z'), snapshot: { platform: 'android', suiteKind: 'name' } },
      // suite A on 'release': always passes.
      { project: 'p1', branch: 'release', suite: 'smoke', status: 'passed', failureKind: null, endedAt: new Date('2026-01-01T01:00:00Z'), snapshot: { platform: 'android', suiteKind: 'name' } },
      { project: 'p1', branch: 'release', suite: 'smoke', status: 'passed', failureKind: null, endedAt: new Date('2026-01-02T01:00:00Z'), snapshot: { platform: 'android', suiteKind: 'name' } },
    ]);

    const result = await computeFlakinessByConfigTuple({ project: 'p1' });

    const main = result.find((r) => r.branch === 'main')!;
    const release = result.find((r) => r.branch === 'release')!;
    expect(main.flakiness).toBeGreaterThan(0);
    expect(release.flakiness).toBe(0);
  });

  it('excludes a cancelled run from the pass-rate calculation but still counts it as a run', async () => {
    mockLeanRuns([
      { project: 'p1', branch: 'main', suite: 'smoke', status: 'passed', failureKind: null, endedAt: new Date('2026-01-01T01:00:00Z'), snapshot: { platform: 'android', suiteKind: 'name' } },
      { project: 'p1', branch: 'main', suite: 'smoke', status: 'cancelled', failureKind: null, endedAt: new Date('2026-01-01T02:00:00Z'), snapshot: { platform: 'android', suiteKind: 'name' } },
    ]);

    const [result] = await computeFlakinessByConfigTuple({ project: 'p1' });

    expect(result.runs).toBe(2);
    expect(result.passRate).toBe(1); // 1 of 1 *attributable* runs passed
  });
});

describe('computeTestCaseFlakiness', () => {
  function mockSortedRuns(runs: unknown[]) {
    const lean = vi.fn().mockResolvedValue(runs);
    const sort = vi.fn().mockReturnValue({ lean });
    const select = vi.fn().mockReturnValue({ sort });
    return vi.spyOn(ExecutionRun, 'find').mockReturnValue({ select } as never);
  }

  it('flags a test that alternates pass/fail across runs of the same configuration', async () => {
    mockSortedRuns([
      { project: 'p1', branch: 'main', suite: 'smoke', endedAt: new Date('2026-01-01'), snapshot: { platform: 'android' }, testSummary: { testCases: [{ id: 't1', name: 'opens home screen', status: 'passed' }] } },
      { project: 'p1', branch: 'main', suite: 'smoke', endedAt: new Date('2026-01-02'), snapshot: { platform: 'android' }, testSummary: { testCases: [{ id: 't1', name: 'opens home screen', status: 'failed' }] } },
      { project: 'p1', branch: 'main', suite: 'smoke', endedAt: new Date('2026-01-03'), snapshot: { platform: 'android' }, testSummary: { testCases: [{ id: 't1', name: 'opens home screen', status: 'passed' }] } },
    ]);

    const [result] = await computeTestCaseFlakiness({ project: 'p1' });

    expect(result.testId).toBe('t1');
    expect(result.alternations).toBe(2); // passed→failed, failed→passed
    expect(result.recentStatuses).toEqual(['passed', 'failed', 'passed']);
  });

  it('never returns a test that is consistently green or consistently red', async () => {
    mockSortedRuns([
      { project: 'p1', branch: 'main', suite: 'smoke', endedAt: new Date('2026-01-01'), snapshot: { platform: 'android' }, testSummary: { testCases: [{ id: 't1', name: 'stable test', status: 'passed' }] } },
      { project: 'p1', branch: 'main', suite: 'smoke', endedAt: new Date('2026-01-02'), snapshot: { platform: 'android' }, testSummary: { testCases: [{ id: 't1', name: 'stable test', status: 'passed' }] } },
    ]);

    const result = await computeTestCaseFlakiness({ project: 'p1' });

    expect(result).toEqual([]);
  });

  it('keeps a separate history per configuration — the same test id under a different branch does not share alternation counts', async () => {
    mockSortedRuns([
      { project: 'p1', branch: 'main', suite: 'smoke', endedAt: new Date('2026-01-01'), snapshot: { platform: 'android' }, testSummary: { testCases: [{ id: 't1', name: 'x', status: 'passed' }] } },
      { project: 'p1', branch: 'release', suite: 'smoke', endedAt: new Date('2026-01-02'), snapshot: { platform: 'android' }, testSummary: { testCases: [{ id: 't1', name: 'x', status: 'passed' }] } },
    ]);

    const result = await computeTestCaseFlakiness({ project: 'p1' });

    // Neither config has more than one data point, so neither can show an
    // alternation — proves they were never pooled into one series of two.
    expect(result).toEqual([]);
  });

  it('caps history at the most recent MAX_TESTCASE_HISTORY runs, oldest evicted first', async () => {
    const runs = Array.from({ length: 12 }, (_, i) => ({
      project: 'p1',
      branch: 'main',
      suite: 'smoke',
      endedAt: new Date(2026, 0, i + 1),
      snapshot: { platform: 'android' },
      testSummary: { testCases: [{ id: 't1', name: 'x', status: i % 2 === 0 ? 'passed' : 'failed' }] },
    }));
    mockSortedRuns(runs);

    const [result] = await computeTestCaseFlakiness({ project: 'p1' });

    expect(result.recentStatuses).toHaveLength(10);
  });
});
