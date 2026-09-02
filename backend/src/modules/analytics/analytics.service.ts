import { ExecutionRun } from '../execution/execution-run.model';
import { Device } from '../devices/device.model';
import { classifySuite } from '../execution/automation-commands';
import { AnalyticsAggregate, IAnalyticsAggregate } from './analytics-aggregate.model';

export const ANALYTICS_RECOMPUTE_INTERVAL_MS = 60 * 60 * 1000; // recompute today's aggregates hourly
export const WEEKLY_RECOMPUTE_INTERVAL_MS = 24 * 60 * 60 * 1000; // the current week changes at most once a day
/** docs/competitive-analysis.md §4f: flakiness = stddev(daily pass rate) over this trailing window. */
export const FLAKINESS_WINDOW_DAYS = 14;

type Platform = 'android' | 'ios' | 'all';

interface RunFacts {
  project: string;
  platform: Platform; // 'all' when the device is unknown, see below
  deviceUdid: string;
  suite: string;
  /** See the note where this is populated: tag and feature are not one suite. */
  suiteKind: 'tag' | 'feature' | 'name' | null;
  status: 'passed' | 'failed' | 'cancelled';
  /** Why a `failed` run failed. See FailureKind in execution-run.model.ts. */
  failureKind: 'test' | 'infra' | 'precondition' | null;
  durationMs: number | null; // null when startedAt was never set (e.g. failed before start)
  /** Test-case counts from the run's Allure results; null when it produced none. */
  tests: { total: number; passed: number } | null;
}

/**
 * Whether a run says anything about the application under test.
 *
 * A run rejected because the device was already locked, or killed by a backend
 * restart, never exercised the app — counting it against pass rate makes a
 * healthy suite look unstable purely from lab contention. Only `passed` and a
 * genuine `test` failure are attributable.
 *
 * Runs predating `failureKind` have it `null`; those are treated as `test`
 * failures, preserving the historical numbers rather than silently restating
 * past reports.
 */
function isTestAttributable(r: RunFacts): boolean {
  if (r.status === 'passed') return true;
  if (r.status === 'failed') return r.failureKind === 'test' || r.failureKind === null;
  return false; // cancelled: a human stopped it, not a verdict on the app
}

function utcDayStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * The Monday (UTC) that starts the ISO 8601 week containing `date` — the
 * `date` field weekly aggregates are keyed and queried by. ISO weeks start
 * Monday, not Sunday; `Date#getUTCDay()` returns 0 for Sunday, so Sunday
 * needs a 6-day rewind rather than the naive `day - 1`.
 */
function isoWeekStart(date: Date): Date {
  const day = utcDayStart(date);
  const daysSinceMonday = day.getUTCDay() === 0 ? 6 : day.getUTCDay() - 1;
  day.setUTCDate(day.getUTCDate() - daysSinceMonday);
  return day;
}

/** Population standard deviation — 0 for fewer than 2 values, since no variance is measurable from one data point (or none). */
function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

type SummaryBySuite = { suite: string; suiteKind: RunFacts['suiteKind']; runs: number; passRate: number };

/**
 * The identity a suite is bucketed and tracked by.
 *
 * `suite` alone is not it: the same string means different test sets
 * depending on whether it was given as a tag or a feature path, and averaging
 * across that is what made flakiness untrustworthy. An unqualified suite (a
 * run predating the snapshot) keeps the bare name as its key, so historical
 * buckets stay continuous rather than every suite appearing to restart.
 */
function suiteKeyOf(suite: string, kind: RunFacts['suiteKind']): string {
  // Historical aggregate rows written before `suiteKind` existed have none
  // stored; classify them the same way, so the key a suite had yesterday is
  // the key it has today and its flakiness series stays continuous.
  return `${kind ?? classifySuite(suite)}:${suite}`;
}

function summarize(
  runs: RunFacts[],
): Pick<IAnalyticsAggregate, 'totalRuns' | 'passedRuns' | 'failedRuns' | 'cancelledRuns' | 'passRate' | 'avgDurationMs' | 'byDevice' | 'totalTests' | 'passedTests' | 'testPassRate' | 'runsWithTestResults'> & {
  bySuite: SummaryBySuite[];
} {
  const passed = runs.filter((r) => r.status === 'passed').length;
  const failed = runs.filter((r) => r.status === 'failed').length;
  const cancelled = runs.filter((r) => r.status === 'cancelled').length;
  const durations = runs.filter((r) => r.durationMs !== null).map((r) => r.durationMs as number);

  // Counts stay honest about everything that happened (totalRuns/failedRuns
  // still include infra and precondition failures — hiding them would make
  // lab problems invisible). Only the *rate* narrows to attributable runs.
  const attributable = runs.filter(isTestAttributable);

  // Test-case-level totals, over the runs that reported any. A run-level rate
  // and a test-level rate answer different questions: 143 of 145 passing is 0%
  // at run level and 98.6% here, and a suite where one test of two hundred
  // flakes used to look identical to one where all two hundred failed.
  //
  // The denominator is deliberately only the runs that produced results, not
  // all of them. A project not using Allure would otherwise drag every rate
  // toward zero by contributing tests it never reported.
  const withTests = runs.filter((r) => r.tests !== null);
  const totalTests = withTests.reduce((sum, r) => sum + (r.tests?.total ?? 0), 0);
  const passedTests = withTests.reduce((sum, r) => sum + (r.tests?.passed ?? 0), 0);

  const groupRate = (group: RunFacts[]): number => {
    const scorable = group.filter(isTestAttributable);
    return scorable.length === 0 ? 0 : scorable.filter((r) => r.status === 'passed').length / scorable.length;
  };

  const byDeviceMap = new Map<string, RunFacts[]>();
  const bySuiteMap = new Map<string, RunFacts[]>();
  for (const r of runs) {
    byDeviceMap.set(r.deviceUdid, [...(byDeviceMap.get(r.deviceUdid) ?? []), r]);
    const key = suiteKeyOf(r.suite, r.suiteKind);
    bySuiteMap.set(key, [...(bySuiteMap.get(key) ?? []), r]);
  }

  return {
    totalRuns: runs.length,
    passedRuns: passed,
    failedRuns: failed,
    cancelledRuns: cancelled,
    passRate: attributable.length === 0 ? 0 : passed / attributable.length,
    totalTests,
    passedTests,
    // 0 when nothing reported tests, matching how passRate handles an empty
    // denominator. `runsWithTestResults` is what tells the two apart, so a
    // reader can see whether a 0 means "all failed" or "nothing reported".
    testPassRate: totalTests === 0 ? 0 : passedTests / totalTests,
    runsWithTestResults: withTests.length,
    avgDurationMs:
      durations.length === 0 ? 0 : Math.round(durations.reduce((a, b) => a + b, 0) / durations.length),
    byDevice: [...byDeviceMap.entries()].map(([deviceUdid, group]) => ({
      deviceUdid,
      runs: group.length,
      passRate: groupRate(group),
    })),
    // Keyed internally by the qualified identity, but reported with `suite`
    // as the bare string — the UI links a suite row straight to
    // `/execution?suite=<suite>`, which filters on what the run actually
    // stored. A qualified value there would match nothing.
    bySuite: [...bySuiteMap.entries()].map(([, group]) => ({
      suite: group[0].suite,
      suiteKind: group[0].suiteKind,
      runs: group.length,
      passRate: groupRate(group),
    })),
  };
}

/**
 * Per-suite flakiness = stddev of that suite's daily pass rate over the
 * trailing FLAKINESS_WINDOW_DAYS (docs/competitive-analysis.md §4f) — a
 * suite alternating pass/fail scores high, one that's consistently green or
 * consistently red scores 0 (population stddev of a constant series is 0),
 * matching what "flaky" actually means (inconsistent, not just failing).
 *
 * Computed from real persisted *daily* AnalyticsAggregate rows, never
 * re-derived from raw runs — so a weekly aggregate's flakiness uses the
 * exact same trailing daily history a same-day daily aggregate would, and
 * the two windows can't drift in what flakiness means the way they're
 * already documented not to drift on "terminal run" above.
 *
 * `windowEnd` is exclusive. `freshRates`, when given, is folded in as the
 * final (most recent) data point — used only when computing the *daily*
 * bucket for `windowEnd`'s own day, since that day's own row doesn't exist
 * in AnalyticsAggregate yet at the point this runs (upsert hasn't happened).
 * A weekly bucket has no such "current day" of its own, so it's omitted
 * there — flakiness is purely the trailing real daily history.
 *
 * A suite with fewer than FLAKINESS_WINDOW_DAYS of history is scored over
 * however many days it actually has, not blocked as "not enough data" —
 * `stddev`'s own <2-point guard already makes a single day read as 0
 * (no evidence of flakiness yet) rather than NaN, which is the honest
 * answer for a suite that's brand new.
 */
async function computeFlakinessBySuite(
  project: string,
  platform: Platform,
  windowEnd: Date,
  freshRates?: Map<string, number>,
): Promise<Map<string, number>> {
  const windowStart = new Date(windowEnd.getTime() - FLAKINESS_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const history = await AnalyticsAggregate.find({
    window: 'daily',
    project,
    platform,
    date: { $gte: windowStart, $lt: windowEnd },
  }).select('bySuite');

  const ratesBySuite = new Map<string, number[]>();
  for (const doc of history) {
    for (const s of doc.bySuite) {
      // Same key the summary buckets by, rebuilt from the stored pair.
      const key = suiteKeyOf(s.suite, s.suiteKind ?? null);
      ratesBySuite.set(key, [...(ratesBySuite.get(key) ?? []), s.passRate]);
    }
  }
  if (freshRates) {
    for (const [suite, rate] of freshRates) {
      ratesBySuite.set(suite, [...(ratesBySuite.get(suite) ?? []), rate]);
    }
  }

  return new Map([...ratesBySuite.entries()].map(([suite, rates]) => [suite, stddev(rates)]));
}

/**
 * Rolls terminal ExecutionRun docs (passed/failed/cancelled, bucketed by
 * endedAt within [rangeStart, rangeEnd)) into AnalyticsAggregate docs keyed
 * by (window, bucketDate, project, platform), upserting on that unique
 * index so recomputing the same window is idempotent. Produces one
 * aggregate per (project, platform-with-data) plus an 'all'-platform
 * rollup per project. Shared by both daily and weekly so the two windows
 * can never drift in what "terminal run" or "platform join" means — weekly
 * deliberately rescans runs rather than summing daily rows: a daily row's
 * avgDurationMs is an average over only the runs that had a duration, and
 * the count of those isn't stored separately from totalRuns, so summing
 * pre-aggregated daily rows cannot exactly reconstruct a weekly average
 * without either a schema change or a documented approximation. Rescanning
 * avoids that gap entirely, and at this app's scale (a device lab, not
 * millions of runs) the extra query cost is not a real tradeoff.
 */
async function computeAggregates(
  window: 'daily' | 'weekly',
  bucketDate: Date,
  rangeStart: Date,
  rangeEnd: Date,
): Promise<IAnalyticsAggregate[]> {
  const runs = await ExecutionRun.find({
    status: { $in: ['passed', 'failed', 'cancelled'] },
    endedAt: { $gte: rangeStart, $lt: rangeEnd },
  });

  // Runs since 2026-09-02 carry their platform in `snapshot`, frozen at
  // trigger time. The live join below is the fallback for older runs only —
  // it is what made history mutable, since deleting a device retroactively
  // unattributed every run that had used it. Back-filling a snapshot for
  // those would be a guess dressed as a fact, so they keep the old behaviour
  // and everything since is stable.
  const udids = [...new Set(runs.filter((r) => !r.snapshot?.platform).map((r) => r.deviceUdid))];
  const devices = udids.length
    ? await Device.find({ udid: { $in: udids } }).select('udid platform')
    : [];
  const platformByUdid = new Map(devices.map((d) => [d.udid, d.platform]));

  const facts: RunFacts[] = runs.map((run) => ({
    project: run.project,
    // A device that has since been removed and left no snapshot resolves to
    // 'all': the run still counts in the per-project rollup, it just cannot be
    // attributed to a specific platform.
    platform: run.snapshot?.platform ?? platformByUdid.get(run.deviceUdid) ?? 'all',
    deviceUdid: run.deviceUdid,
    suite: run.suite,
    // How the suite was addressed. A Cucumber tag and a feature path select
    // different sets of tests, so a bucket mixing them is not one suite's
    // history — and flakiness, being a variance measure over that history, is
    // the metric that corrupted.
    //
    // Runs predating the snapshot fall back to classifying the string, not to
    // null. That is not a guess: `classifySuite` is a pure function of the
    // suite string and is the same function the runner used to pick its flag
    // when the run happened, so it recovers the kind rather than inventing it.
    // Falling back to null instead was tried and was visibly wrong — the same
    // feature file showed up as two rows, one unqualified and one qualified,
    // splitting its history at the moment the snapshot was introduced.
    suiteKind: run.snapshot?.suiteKind ?? classifySuite(run.suite),
    status: run.status as RunFacts['status'],
    failureKind: run.failureKind ?? null,
    durationMs:
      run.startedAt && run.endedAt ? run.endedAt.getTime() - run.startedAt.getTime() : null,
    tests: run.testSummary ? { total: run.testSummary.total, passed: run.testSummary.passed } : null,
  }));

  const written: IAnalyticsAggregate[] = [];
  const projects = [...new Set(facts.map((f) => f.project))];

  for (const project of projects) {
    const projectFacts = facts.filter((f) => f.project === project);
    const platformsWithData = [...new Set(projectFacts.map((f) => f.platform))].filter((p) => p !== 'all');
    const buckets: Array<{ platform: Platform; group: RunFacts[] }> = [
      ...platformsWithData.map((platform) => ({
        platform,
        group: projectFacts.filter((f) => f.platform === platform),
      })),
      { platform: 'all' as const, group: projectFacts },
    ];

    for (const { platform, group } of buckets) {
      const summary = summarize(group);

      // Only a *daily* bucket represents "today" itself, which isn't yet a
      // persisted row for computeFlakinessBySuite's history query to find —
      // fold its own fresh rates in as the window's final data point. A
      // weekly bucket isn't a single day, so it contributes nothing of its
      // own; flakiness there is purely the real trailing daily history.
      // Keyed by the qualified suite identity throughout, so a tag and a
      // feature path that happen to share a name do not pool their rates into
      // one variance figure.
      const freshRates =
        window === 'daily'
          ? new Map(summary.bySuite.map((s) => [suiteKeyOf(s.suite, s.suiteKind), s.passRate]))
          : undefined;
      const flakinessBySuite = await computeFlakinessBySuite(project, platform, rangeEnd, freshRates);
      const bySuite = summary.bySuite.map((s) => ({
        ...s,
        flakiness: flakinessBySuite.get(suiteKeyOf(s.suite, s.suiteKind)) ?? 0,
      }));

      const doc = await AnalyticsAggregate.findOneAndUpdate(
        { window, date: bucketDate, project, platform },
        { ...summary, bySuite, computedAt: new Date() },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
      written.push(doc);
    }
  }

  return written;
}

/** Recomputes the daily aggregate for the UTC day containing `date`. */
export async function computeDailyAggregates(date: Date = new Date()): Promise<IAnalyticsAggregate[]> {
  const dayStart = utcDayStart(date);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  return computeAggregates('daily', dayStart, dayStart, dayEnd);
}

/**
 * Recomputes the weekly aggregate for the ISO week containing `date`. The
 * `date` field on a weekly row is that week's Monday (UTC) — the same value
 * `isoWeekStart` returns for any date in that week, so re-running for any
 * day within the week upserts the same row.
 */
export async function computeWeeklyAggregates(date: Date = new Date()): Promise<IAnalyticsAggregate[]> {
  const weekStart = isoWeekStart(date);
  const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);
  return computeAggregates('weekly', weekStart, weekStart, weekEnd);
}

export async function queryAggregates(filters: {
  project?: string;
  platform?: string;
  window?: string;
  from?: Date;
  to?: Date;
}): Promise<IAnalyticsAggregate[]> {
  const query: Record<string, unknown> = {};
  if (filters.project) query.project = filters.project;
  if (filters.platform) query.platform = filters.platform;
  if (filters.window) query.window = filters.window;
  if (filters.from || filters.to) {
    query.date = {
      ...(filters.from ? { $gte: utcDayStart(filters.from) } : {}),
      ...(filters.to ? { $lte: utcDayStart(filters.to) } : {}),
    };
  }
  return AnalyticsAggregate.find(query).sort({ date: -1, project: 1, platform: 1 });
}
