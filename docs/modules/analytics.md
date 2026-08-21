# Module: Analytics & Reporting

**Status:** planned — no code written (targeted for V2, possible V1 pull-forward).
**Blueprint ref:** [architecture-blueprint.md §4 (AnalyticsAggregate), §5 (AnalyticsService), §12d](../architecture-blueprint.md)
**Competitive context:** [competitive-analysis.md §4f](../competitive-analysis.md)

---

## Purpose

Surface actionable test health data: pass rates, run volume trends, flakiness scores, and device utilisation — computed from `ExecutionRun` history and served fast via pre-aggregated MongoDB documents. The analytics gap is the most consistent complaint about open-source device lab tools from enterprise evaluators; a functional analytics dashboard is what moves Mobile Hub from "interesting OSS project" to "production-ready tool."

---

## The core problems this module solves

1. **No OSS device lab ships analytics.** Teams running OpenSTF or appium-device-farm get a log file. No pass-rate trends, no flakiness detection, no device utilisation. Mobile Hub closes this gap without building a full BI platform.

2. **Flat MongoDB queries on run history don't scale.** Querying `ExecutionRun` directly for trend charts at 10K+ runs is slow. Pre-aggregating into `AnalyticsAggregate` on a schedule keeps read latency flat regardless of run volume.

3. **Dashboard state isn't shareable.** Most OSS dashboards reset to defaults on every load. Mobile Hub syncs all filter state to the URL — sharing a filtered view is a copy-paste of the address bar.

---

## Data model

### AnalyticsAggregate
```ts
{
  _id,
  window: 'daily' | 'weekly',
  date: Date,                     // start of the window (midnight UTC)
  project: string,
  platform: 'android' | 'ios' | 'all',
  totalRuns: number,
  passedRuns: number,
  failedRuns: number,
  cancelledRuns: number,
  passRate: number,               // 0–1
  avgDurationMs: number,
  byDevice: [
    {
      deviceUdid: string,
      runs: number,
      passRate: number
    }
  ],
  bySuite: [
    {
      suite: string,
      runs: number,
      passRate: number,
      flakiness: number           // stddev of daily pass rates over 14-day window
    }
  ],
  computedAt: Date                // when this aggregate was last computed
}
```

`computedAt` drives invalidation: `AnalyticsService` recomputes any aggregate older than **2 hours** on the next scheduled run. This prevents stale aggregates from being served indefinitely after data-model changes or backfills.

---

## Aggregation pipeline

`AnalyticsService` runs on a cron schedule (every hour). For each `(project, platform, window, date)` bucket that has new `ExecutionRun` data since `computedAt`:

```ts
// MongoDB aggregation — pseudo-code
db.executionruns.aggregate([
  { $match: { project, platform, createdAt: { $gte: windowStart, $lt: windowEnd } } },
  { $group: {
      _id: { deviceUdid: '$deviceUdid', suite: '$suite' },
      runs: { $sum: 1 },
      passed: { $sum: { $cond: [{ $eq: ['$status', 'passed'] }, 1, 0] } },
      avgDuration: { $avg: { $subtract: ['$endedAt', '$startedAt'] } }
  }},
  // ... reshape into AnalyticsAggregate shape
])
```

The aggregation result is upserted into `AnalyticsAggregate` with `computedAt = now`. Controllers read from `AnalyticsAggregate` only — they never query `ExecutionRun` directly.

---

## Flakiness score

Flakiness measures inconsistency, not failure. A suite that always fails is not flaky — it's broken. A suite that alternates between pass and fail unpredictably is flaky.

**Formula:** `stddev` of daily pass rates over the 14-day rolling window.

```ts
function flakinessScore(dailyPassRates: number[]): number {
  if (dailyPassRates.length < 3) return 0;  // not enough data
  const mean = dailyPassRates.reduce((a, b) => a + b, 0) / dailyPassRates.length;
  const variance = dailyPassRates.reduce((acc, r) => acc + Math.pow(r - mean, 2), 0) / dailyPassRates.length;
  return Math.sqrt(variance);
}
```

- Score of `0` = perfectly consistent (always passes or always fails).
- Score of `0.5` = maximum inconsistency (alternates 0% and 100% pass rate each day).
- Suites with fewer than 3 data points in the window are excluded from the flakiness table.

Flakiness is stored in `AnalyticsAggregate.bySuite[n].flakiness` and is recomputed with every hourly aggregation.

---

## Dashboard layout — 6 zones

```
┌─────────────────────────────────────────────────────┐
│  [1] Summary KPI strip                               │
│  Total runs | Pass rate | Avg duration | Δ vs prev   │
├───────────────────────┬─────────────────────────────┤
│  [2] Pass rate trend  │  [3] Run volume              │
│  LineChart, by day    │  BarChart, by status         │
├───────────────────────┴─────────────────────────────┤
│  [4] Flakiness table                                 │
│  Suite | Runs | Pass rate | Flakiness score | Trend  │
├─────────────────────────────────────────────────────┤
│  [5] Device utilisation                              │
│  Device | Runs | Pass rate  (tabular)                │
├─────────────────────────────────────────────────────┤
│  [6] Recent failures                                 │
│  Run ID | Suite | Device | Error | Link to run       │
└─────────────────────────────────────────────────────┘
```

**Zone 1 — Summary KPIs:** current period totals with delta vs previous period (e.g. pass rate up 3pp vs last week). Computed from two `AnalyticsAggregate` windows.

**Zone 2 — Pass rate trend:** `recharts LineChart`. X-axis = date (daily buckets). Y-axis = pass rate %. One line per platform if multi-platform filter is active.

**Zone 3 — Run volume:** `recharts BarChart` (stacked). X-axis = date. Y-axis = run count. Bars segmented by `passed / failed / cancelled`.

**Zone 4 — Flakiness table:** sorted by `flakiness` descending by default. Columns sortable. Minimum 3 data points to appear.

**Zone 5 — Device utilisation:** tabular, no chart needed. Sortable by run count or pass rate.

**Zone 6 — Recent failures:** last 20 failed runs, with direct deep links to the run detail page (which has the Allure report and SSE log).

---

## Chart library

Use **recharts** for all analytics charts. It is already chosen and confirmed:
- `LineChart` for pass rate trend (zone 2)
- `BarChart` (stacked) for run volume (zone 3)

Do not pull in a second chart library. Do not use a heavy dashboard framework (Apache ECharts, Chart.js, Victory) — recharts covers everything needed here without the bundle weight.

---

## URL-synced filter pattern

All analytics filters persist in the URL query string. This makes dashboard states bookmarkable and shareable — a filtered view is a copy-paste of the address bar.

```ts
// frontend/src/features/analytics/hooks/useAnalyticsFilters.ts

type AnalyticsFilters = {
  dateRange: '7d' | '14d' | '30d' | 'custom';
  startDate?: string;   // ISO 8601
  endDate?: string;
  platform: 'android' | 'ios' | 'all';
  project: string;
  window: 'daily' | 'weekly';
};

function filtersToParams(filters: AnalyticsFilters): URLSearchParams { ... }
function paramsToFilters(params: URLSearchParams): AnalyticsFilters { ... }
```

`useAnalyticsFilters` composes `useSearchParams` (React Router) with these two functions. Filter changes update the URL without a full navigation — back button restores the previous filter state.

The filter object is passed directly into the TanStack Query key, so any filter change triggers a fresh query automatically.

---

## Frontend hook pattern

```ts
// frontend/src/features/analytics/hooks/useAnalytics.ts

function useAnalyticsSummary(filters: AnalyticsFilters) {
  return useQuery({
    queryKey: ['analytics', 'summary', filters],
    queryFn: () => analyticsApi.getSummary(filters),
    staleTime: 5 * 60 * 1000  // 5 min — aggregates are recomputed hourly
  });
}

function usePassRateTrend(filters: AnalyticsFilters) { ... }
function useRunVolume(filters: AnalyticsFilters) { ... }
function useFlakiness(filters: AnalyticsFilters) { ... }
function useDeviceUtilisation(filters: AnalyticsFilters) { ... }
function useRecentFailures(filters: AnalyticsFilters) { ... }
```

Each dashboard zone has its own hook — they can independently refresh, show loading states, and fail without breaking other zones. The `staleTime` is set to 5 minutes (aggregates are recomputed hourly — there is no point refetching more often than that).

---

## AnalyticsService responsibilities

| Responsibility | Notes |
|---|---|
| Scheduled aggregation | Cron every hour; computes all `(project, platform, window)` buckets that have new data |
| `getAggregate(filters)` | Reads from `AnalyticsAggregate`; never queries `ExecutionRun` directly |
| `getRecentFailures(filters)` | Reads from `ExecutionRun` directly — not aggregated, always fresh |
| Flakiness computation | Runs inline during aggregation; stored in `bySuite[n].flakiness` |
| TTL enforcement | Recomputes any aggregate where `computedAt < (now - 2h)` on the next schedule tick |

`AnalyticsService` is intentionally separate from `ExecutionOrchestrationService`. These two services have completely different scaling and failure characteristics — don't merge them.

---

## API surface

```
GET /api/analytics/summary          — KPI strip data (viewer+)
    ?project=&platform=&dateRange=&startDate=&endDate=&window=

GET /api/analytics/trend/pass-rate  — pass rate by day/week (viewer+)
GET /api/analytics/trend/volume     — run volume by day/week (viewer+)
GET /api/analytics/flakiness        — flakiness table (viewer+)
GET /api/analytics/devices          — device utilisation (viewer+)
GET /api/analytics/failures/recent  — last N failed runs (viewer+)
```

All endpoints accept the same filter query params (project, platform, dateRange, startDate, endDate, window). All responses are read from `AnalyticsAggregate` except `/failures/recent` which reads directly from `ExecutionRun`.

If `features.analytics === false` for an org, all analytics endpoints return `403 Feature disabled`.

---

## Known issues from reference — and Mobile Hub fixes

| Reference issue | Root cause | Mobile Hub fix |
|---|---|---|
| Stale aggregates served indefinitely | Analytics cache had no TTL | `AnalyticsAggregate.computedAt` field; recompute any aggregate older than 2h |
| Journey/session correlation by time proximity | No explicit session ID on runs | `ExecutionRun` has `_id` — correlation uses explicit ID, not time-window guessing |
| Dashboard state lost on page reload | No URL sync | `filtersToParams` / `paramsToFilters` pattern; all filters in URL query string |
| Analytics and orchestration in the same service | Tight coupling, different failure modes | `AnalyticsService` is a separate class/module; intentionally cannot call orchestration methods |
| Direct `ExecutionRun` queries from analytics controllers | No pre-aggregation, slow at scale | All analytics reads from `AnalyticsAggregate`; only `/failures/recent` hits `ExecutionRun` |
