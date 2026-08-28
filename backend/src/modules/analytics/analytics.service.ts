import { ExecutionRun } from '../execution/execution-run.model';
import { Device } from '../devices/device.model';
import { AnalyticsAggregate, IAnalyticsAggregate } from './analytics-aggregate.model';

export const ANALYTICS_RECOMPUTE_INTERVAL_MS = 60 * 60 * 1000; // recompute today's aggregates hourly
export const WEEKLY_RECOMPUTE_INTERVAL_MS = 24 * 60 * 60 * 1000; // the current week changes at most once a day

type Platform = 'android' | 'ios' | 'all';

interface RunFacts {
  project: string;
  platform: Platform; // 'all' when the device is unknown, see below
  deviceUdid: string;
  suite: string;
  status: 'passed' | 'failed' | 'cancelled';
  durationMs: number | null; // null when startedAt was never set (e.g. failed before start)
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

function summarize(runs: RunFacts[]): Pick<
  IAnalyticsAggregate,
  'totalRuns' | 'passedRuns' | 'failedRuns' | 'cancelledRuns' | 'passRate' | 'avgDurationMs' | 'byDevice' | 'bySuite'
> {
  const passed = runs.filter((r) => r.status === 'passed').length;
  const failed = runs.filter((r) => r.status === 'failed').length;
  const cancelled = runs.filter((r) => r.status === 'cancelled').length;
  const durations = runs.filter((r) => r.durationMs !== null).map((r) => r.durationMs as number);

  const groupRate = (group: RunFacts[]): number =>
    group.length === 0 ? 0 : group.filter((r) => r.status === 'passed').length / group.length;

  const byDeviceMap = new Map<string, RunFacts[]>();
  const bySuiteMap = new Map<string, RunFacts[]>();
  for (const r of runs) {
    byDeviceMap.set(r.deviceUdid, [...(byDeviceMap.get(r.deviceUdid) ?? []), r]);
    bySuiteMap.set(r.suite, [...(bySuiteMap.get(r.suite) ?? []), r]);
  }

  return {
    totalRuns: runs.length,
    passedRuns: passed,
    failedRuns: failed,
    cancelledRuns: cancelled,
    passRate: runs.length === 0 ? 0 : passed / runs.length,
    avgDurationMs:
      durations.length === 0 ? 0 : Math.round(durations.reduce((a, b) => a + b, 0) / durations.length),
    byDevice: [...byDeviceMap.entries()].map(([deviceUdid, group]) => ({
      deviceUdid,
      runs: group.length,
      passRate: groupRate(group),
    })),
    // flakiness is 0 for v1 - computing it properly needs retry/history
    // correlation (same suite+branch flip-flopping pass/fail), which doesn't
    // exist yet. The field stays in the schema so the API shape is stable.
    bySuite: [...bySuiteMap.entries()].map(([suite, group]) => ({
      suite,
      runs: group.length,
      passRate: groupRate(group),
      flakiness: 0,
    })),
  };
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

  // Resolve each run's platform via its device. A device that has since been
  // removed from inventory resolves to 'all': the run still counts in the
  // per-project rollup, it just can't be attributed to a specific platform.
  const udids = [...new Set(runs.map((r) => r.deviceUdid))];
  const devices = await Device.find({ udid: { $in: udids } }).select('udid platform');
  const platformByUdid = new Map(devices.map((d) => [d.udid, d.platform]));

  const facts: RunFacts[] = runs.map((run) => ({
    project: run.project,
    platform: platformByUdid.get(run.deviceUdid) ?? 'all',
    deviceUdid: run.deviceUdid,
    suite: run.suite,
    status: run.status as RunFacts['status'],
    durationMs:
      run.startedAt && run.endedAt ? run.endedAt.getTime() - run.startedAt.getTime() : null,
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
      const doc = await AnalyticsAggregate.findOneAndUpdate(
        { window, date: bucketDate, project, platform },
        { ...summarize(group), computedAt: new Date() },
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
