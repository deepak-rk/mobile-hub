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
  return isAttributable(r.status, r.failureKind);
}

/**
 * The primitive `isTestAttributable` is built on, exposed separately so the
 * config-tuple flakiness measure below can apply the exact same rule to raw
 * `ExecutionRun` fields without first mapping them into a `RunFacts`.
 */
function isAttributable(status: string, failureKind: string | null): boolean {
  if (status === 'passed') return true;
  if (status === 'failed') return failureKind === 'test' || failureKind === null;
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

export const FAILURE_REASONS_WINDOW_DAYS = 30;

export interface FailureReasonSummary {
  /** Normalized dedup key — never shown to a user, only used for grouping. */
  signature: string;
  /** The first occurrence's real message, truncated per allure-summary.ts — what's actually displayed. */
  message: string;
  /** Total failed tests across every matched run, not just how many runs saw it. */
  count: number;
  /** How many distinct runs contributed to `count` — a message hit by one flaky run 10 times and a message hit by 10 different runs once each both have count 10, but very different implications. */
  runCount: number;
  lastSeenAt: Date;
}

/**
 * Strips the volatile parts of a failure message — long hex/numeric ids,
 * timestamps, counts — so two occurrences of "logically the same" failure
 * with different specific values (a different run id, a different port, a
 * different retry count) group into one bucket instead of fragmenting into
 * one each. This is the exact mistake `docs/SOURCE_FEATURE_TRACEABILITY.md`
 * names in the reference implementation: it grouped by the raw string and
 * splintered on any variable content.
 *
 * Deliberately conservative: this cannot tell an `AssertionError` from a
 * `TimeoutError` that happens to share wording after normalization, since
 * Allure's `statusDetails.message` carries no structured exception-type
 * field to key on separately — only a heuristic over the free-text string.
 * Good enough to answer "what keeps failing", not precise enough to be the
 * only signal a human uses to decide two failures are unrelated.
 */
export function normalizeFailureMessage(message: string): string {
  return message
    .toLowerCase()
    .replace(/[0-9a-f]{8,}/g, '<id>') // long hex ids/hashes
    .replace(/\d+/g, '<n>') // any remaining run of digits (counts, ports, timestamps)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Recurring failure reasons across many runs — "recent failures" on one run
 * answers *what failed*; this answers *what fails repeatedly*, which is a
 * different question needing a different view. Per-run grouping (added
 * 2026-09-02, `allure-summary.ts`) already exists; this is the aggregate
 * layer on top of it that was deliberately left for a dedup design, not
 * forgotten — see docs/TODO.md.
 */
export async function computeFailureReasons(filters: {
  project?: string;
  platform?: Platform;
  suite?: string;
  days?: number;
}): Promise<{ reasons: FailureReasonSummary[]; scannedRuns: number }> {
  const since = new Date(Date.now() - (filters.days ?? FAILURE_REASONS_WINDOW_DAYS) * 24 * 60 * 60 * 1000);

  const query: Record<string, unknown> = {
    createdAt: { $gte: since },
    'testSummary.failures.0': { $exists: true },
  };
  if (filters.project) query.project = filters.project;
  if (filters.suite) query.suite = filters.suite;

  const runs = await ExecutionRun.find(query)
    .select('testSummary snapshot createdAt')
    .sort({ createdAt: 1 })
    .lean();

  // Platform is only known via the snapshot (frozen at trigger time, see
  // execution.service.ts) — a run predating it has no reliable platform to
  // filter by, so it's excluded rather than guessed when a platform filter
  // is actually requested. Unfiltered queries still include it.
  const scoped =
    filters.platform && filters.platform !== 'all'
      ? runs.filter((r) => r.snapshot?.platform === filters.platform)
      : runs;

  const bySignature = new Map<string, FailureReasonSummary>();
  for (const run of scoped) {
    for (const f of run.testSummary?.failures ?? []) {
      const signature = normalizeFailureMessage(f.message);
      const existing = bySignature.get(signature);
      if (existing) {
        existing.count += f.count;
        existing.runCount += 1;
        existing.lastSeenAt = run.createdAt;
      } else {
        bySignature.set(signature, {
          signature,
          message: f.message,
          count: f.count,
          runCount: 1,
          lastSeenAt: run.createdAt,
        });
      }
    }
  }

  return {
    reasons: [...bySignature.values()].sort((a, b) => b.count - a.count),
    scannedRuns: scoped.length,
  };
}

export const DEVICE_UTILISATION_WINDOW_DAYS = 14;

export interface DeviceUtilisation {
  deviceUdid: string;
  busyMs: number;
  windowMs: number;
  /** Fraction of the window this device spent inside a run's [startedAt, endedAt), 0–1. */
  utilisation: number;
  runs: number;
}

/**
 * What fraction of the window each device actually spent running something,
 * vs sitting idle — a capacity-planning question ("do we need more
 * devices") that pass-rate/duration metrics don't answer.
 *
 * Derived entirely from `ExecutionRun.startedAt`/`endedAt`, already recorded
 * for every terminal run — no new tracking needed. `Device.lock` only ever
 * holds the *current* lock and is cleared on release, so it has no history
 * to query; a run's own start/end window is the durable record of when a
 * device was actually held.
 */
export async function computeDeviceUtilisation(filters: {
  project?: string;
  platform?: Platform;
  days?: number;
}): Promise<DeviceUtilisation[]> {
  const days = filters.days ?? DEVICE_UTILISATION_WINDOW_DAYS;
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - days * 24 * 60 * 60 * 1000);
  const windowMs = windowEnd.getTime() - windowStart.getTime();

  const query: Record<string, unknown> = {
    startedAt: { $gte: windowStart, $ne: null },
    endedAt: { $ne: null },
  };
  if (filters.project) query.project = filters.project;

  const runs = await ExecutionRun.find(query).select('deviceUdid startedAt endedAt snapshot').lean();
  const scoped =
    filters.platform && filters.platform !== 'all'
      ? runs.filter((r) => r.snapshot?.platform === filters.platform)
      : runs;

  const byDevice = new Map<string, { busyMs: number; runs: number }>();
  for (const r of scoped) {
    if (!r.startedAt || !r.endedAt) continue;
    const entry = byDevice.get(r.deviceUdid) ?? { busyMs: 0, runs: 0 };
    entry.busyMs += r.endedAt.getTime() - r.startedAt.getTime();
    entry.runs += 1;
    byDevice.set(r.deviceUdid, entry);
  }

  return [...byDevice.entries()]
    .map(([deviceUdid, { busyMs, runs }]) => ({
      deviceUdid,
      busyMs,
      windowMs,
      // Capped defensively — the device lock should make overlapping run
      // windows impossible, but a metric that could silently read above
      // 100% is a worse failure mode than one that caps.
      utilisation: Math.min(1, busyMs / windowMs),
      runs,
    }))
    .sort((a, b) => b.utilisation - a.utilisation);
}

export interface ConfigTupleFlakiness {
  project: string;
  platform: Platform;
  suite: string;
  suiteKind: RunFacts['suiteKind'];
  branch: string;
  runs: number;
  passRate: number;
  /** stddev of this exact tuple's own daily pass rate over the window — same measure as computeFlakinessBySuite, different grouping. */
  flakiness: number;
}

/**
 * Flakiness at the granularity of one full run configuration (suite + branch
 * + platform), not just suite. A specific branch/platform combination can be
 * genuinely unstable while the suite-level measure above looks fine,
 * averaged out by everything else in the suite sharing that bucket.
 *
 * Deliberately on-demand from raw runs (like `computeFailureReasons`), not
 * from the persisted daily `AnalyticsAggregate` rows the suite-level measure
 * reads — adding this grouping to that schema/pipeline would be a bigger,
 * riskier change than this metric's current value justifies. Revisit only if
 * this needs to share the daily-aggregate pipeline's performance
 * characteristics at a scale where scanning raw runs stops being cheap.
 */
export async function computeFlakinessByConfigTuple(filters: {
  project?: string;
  platform?: Platform;
  days?: number;
}): Promise<ConfigTupleFlakiness[]> {
  const days = filters.days ?? FLAKINESS_WINDOW_DAYS;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const query: Record<string, unknown> = {
    status: { $in: ['passed', 'failed', 'cancelled'] },
    endedAt: { $gte: since },
  };
  if (filters.project) query.project = filters.project;

  const runs = await ExecutionRun.find(query).select('project branch suite status failureKind endedAt snapshot').lean();
  const scoped =
    filters.platform && filters.platform !== 'all'
      ? runs.filter((r) => r.snapshot?.platform === filters.platform)
      : runs;

  interface TupleRun {
    status: string;
    failureKind: string | null;
    endedAt: Date;
  }
  interface TupleGroup {
    project: string;
    platform: Platform;
    suite: string;
    suiteKind: RunFacts['suiteKind'];
    branch: string;
    runs: TupleRun[];
  }
  const groups = new Map<string, TupleGroup>();
  for (const r of scoped) {
    const platform = r.snapshot?.platform ?? 'all';
    const suiteKind = r.snapshot?.suiteKind ?? classifySuite(r.suite);
    const key = `${r.project}::${platform}::${suiteKeyOf(r.suite, suiteKind)}::${r.branch}`;
    const group =
      groups.get(key) ?? { project: r.project, platform, suite: r.suite, suiteKind, branch: r.branch, runs: [] };
    group.runs.push({ status: r.status, failureKind: r.failureKind ?? null, endedAt: r.endedAt as Date });
    groups.set(key, group);
  }

  return [...groups.values()]
    .map((g) => {
      const attributable = g.runs.filter((r) => isAttributable(r.status, r.failureKind));
      const passRate =
        attributable.length === 0 ? 0 : attributable.filter((r) => r.status === 'passed').length / attributable.length;

      // Daily pass-rate series across this tuple's own runs, same shape as
      // computeFlakinessBySuite's measure — see the doc comment above for
      // why this stays independently computed rather than sharing its
      // persisted history.
      const byDay = new Map<string, TupleRun[]>();
      for (const r of g.runs) {
        const day = utcDayStart(r.endedAt).toISOString();
        byDay.set(day, [...(byDay.get(day) ?? []), r]);
      }
      const dailyRates = [...byDay.values()].map((dayRuns) => {
        const dayAttributable = dayRuns.filter((r) => isAttributable(r.status, r.failureKind));
        return dayAttributable.length === 0
          ? 0
          : dayAttributable.filter((r) => r.status === 'passed').length / dayAttributable.length;
      });

      return {
        project: g.project,
        platform: g.platform,
        suite: g.suite,
        suiteKind: g.suiteKind,
        branch: g.branch,
        runs: g.runs.length,
        passRate,
        flakiness: stddev(dailyRates),
      };
    })
    .sort((a, b) => b.flakiness - a.flakiness);
}

export interface TestCaseFlakiness {
  project: string;
  platform: Platform;
  suite: string;
  branch: string;
  testId: string;
  testName: string;
  /** Oldest-first, capped at the most recent MAX_TESTCASE_HISTORY runs of this exact configuration. */
  recentStatuses: string[];
  /** Adjacent-run transitions between passed and not-passed — 0 for a consistently green or consistently red test, never returned. */
  alternations: number;
}

/** How many recent runs of a config a single test's history is judged over — bounds memory and keeps the signal about "is this flaky right now", not its whole history. */
const MAX_TESTCASE_HISTORY = 10;

/**
 * The most actionable of the three flakiness granularities: which *one named
 * test*, not which suite or which full configuration, is inconsistent across
 * recent runs of the same configuration — the suite- and config-tuple-level
 * measures above can only say a bucket is unstable, not which single test
 * inside it is the cause.
 *
 * Requires per-test-case history (`ExecutionRun.testSummary.testCases`,
 * added alongside this function) — a run recorded before that field existed
 * simply contributes nothing here, same convention as every other field on
 * this schema that isn't present on historical runs.
 */
export async function computeTestCaseFlakiness(filters: {
  project?: string;
  platform?: Platform;
  days?: number;
}): Promise<TestCaseFlakiness[]> {
  const days = filters.days ?? FLAKINESS_WINDOW_DAYS;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const query: Record<string, unknown> = {
    endedAt: { $gte: since },
    'testSummary.testCases.0': { $exists: true },
  };
  if (filters.project) query.project = filters.project;

  const runs = await ExecutionRun.find(query)
    .select('project branch suite endedAt snapshot testSummary')
    .sort({ endedAt: 1 })
    .lean();
  const scoped =
    filters.platform && filters.platform !== 'all'
      ? runs.filter((r) => r.snapshot?.platform === filters.platform)
      : runs;

  interface ConfigGroup {
    meta: { project: string; platform: Platform; suite: string; branch: string };
    tests: Map<string, { name: string; statuses: string[] }>;
  }
  const byConfig = new Map<string, ConfigGroup>();

  for (const r of scoped) {
    const platform = r.snapshot?.platform ?? 'all';
    const configKey = `${r.project}::${platform}::${r.suite}::${r.branch}`;
    let group = byConfig.get(configKey);
    if (!group) {
      group = { meta: { project: r.project, platform, suite: r.suite, branch: r.branch }, tests: new Map() };
      byConfig.set(configKey, group);
    }
    for (const tc of r.testSummary?.testCases ?? []) {
      const existing = group.tests.get(tc.id) ?? { name: tc.name, statuses: [] as string[] };
      existing.statuses.push(tc.status);
      // Runs were fetched oldest-first, so the oldest entry is always the one
      // to drop once the cap is exceeded.
      if (existing.statuses.length > MAX_TESTCASE_HISTORY) existing.statuses.shift();
      group.tests.set(tc.id, existing);
    }
  }

  const results: TestCaseFlakiness[] = [];
  for (const { meta, tests } of byConfig.values()) {
    for (const [testId, { name, statuses }] of tests.entries()) {
      let alternations = 0;
      for (let i = 1; i < statuses.length; i++) {
        if ((statuses[i - 1] === 'passed') !== (statuses[i] === 'passed')) alternations += 1;
      }
      if (alternations === 0) continue; // consistently green or consistently red — not what "flaky" means here
      results.push({ ...meta, testId, testName: name, recentStatuses: statuses, alternations });
    }
  }

  return results.sort((a, b) => b.alternations - a.alternations);
}
