import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { createColumnHelper, flexRender, getCoreRowModel, getSortedRowModel, SortingState, useReactTable } from '@tanstack/react-table';
import {
  Card,
  CardBody,
  EmptyState,
  Mono,
  Page,
  PageHeader,
  ProgressBar,
  QueryBoundary,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
} from 'react-design-kit';
import { icons } from '@/lib/icons';
import { formatPercent, formatRelative } from 'ts-format-utils';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { useExecutionRuns } from '@/features/execution/api/execution.api';
import {
  useAnalytics,
  useConfigFlakiness,
  useDeviceUtilisation,
  useFailureReasons,
  useTestCaseFlakiness,
} from '../api/analytics.api';
import { AnalyticsFilterBar } from '../components/AnalyticsFilterBar';
import { useAnalyticsFilters } from '../hooks/useAnalyticsFilters';
import type { AnalyticsAggregate, DeviceBreakdown, SuiteBreakdown } from '../types';
import styles from './AnalyticsPage.module.css';

function passRateTone(rate: number): string {
  if (rate >= 0.9) return 'var(--status-passed)';
  if (rate >= 0.6) return 'var(--status-smoke)';
  return 'var(--status-failed)';
}

function formatAvgDuration(ms: number): string {
  if (!ms) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

function Kpi({
  label,
  value,
  tone,
  sub,
}: {
  label: string;
  value: string;
  tone?: string;
  /** One line under the number, for a figure whose denominator isn't obvious. */
  sub?: string;
}) {
  return (
    <Card>
      <CardBody>
        <div className={styles.kpiLabel}>{label}</div>
        <div className={styles.kpiValue} style={tone ? { color: tone } : undefined}>
          {value}
        </div>
        {sub ? <div className={styles.kpiSub}>{sub}</div> : null}
      </CardBody>
    </Card>
  );
}

/** Named for what the operator picked, not for the runner flag it becomes. */
const SUITE_KIND_LABELS: Record<'tag' | 'feature' | 'name', string> = {
  tag: 'tag',
  feature: 'feature file',
  name: 'named suite',
};

function platformLabel(platform: AnalyticsAggregate['platform']): string {
  if (platform === 'all') return 'All platforms';
  return platform === 'ios' ? 'iOS' : 'Android';
}

/** Shared cell renderer: a pass rate as a tinted bar + percentage + run count, used by both breakdown tables below. */
function PassRateCell({ passRate, runs }: { passRate: number; runs: number }) {
  return (
    <div className={styles.rateCell}>
      <span className={styles.rateBar}>
        <ProgressBar value={passRate * 100} tone={passRateTone(passRate)} />
      </span>
      <span className={styles.rateValue}>
        {formatPercent(passRate)}
        <span className={styles.rateRuns}>{runs} runs</span>
      </span>
    </div>
  );
}

/**
 * Pass rate over time for one project/platform.
 *
 * Rendered only from two points up: a line through a single aggregate is a dot
 * with an axis, which reads as insight without being any. Percentages are
 * plotted on a fixed 0–100 axis so two charts side by side are comparable —
 * an auto-scaled axis would make 88%–92% look like a collapse.
 */
function PassRateTrend({ points }: { points: TrendPoint[] }) {
  if (points.length < 2) {
    return (
      <p className={styles.none}>
        A trend needs at least two {points.length === 1 ? 'periods' : 'periods'} — one more run window and this fills
        in.
      </p>
    );
  }

  return (
    <div className={styles.chart}>
      <ResponsiveContainer width="100%" height={200}>
        {/* Right margin holds the last x-axis label, which is centred on the
            final point and would otherwise be clipped by the container edge. */}
        <LineChart data={points} margin={{ top: 8, right: 24, bottom: 0, left: -20 }}>
          <CartesianGrid stroke="var(--border-subtle)" vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fill: 'var(--text-tertiary)', fontSize: 11 }}
            stroke="var(--border-subtle)"
          />
          <YAxis
            domain={[0, 100]}
            tickFormatter={(v: number) => `${v}%`}
            tick={{ fill: 'var(--text-tertiary)', fontSize: 11 }}
            stroke="var(--border-subtle)"
          />
          <Tooltip
            contentStyle={{
              background: 'var(--surface-raised)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 8,
              color: 'var(--text-primary)',
            }}
            formatter={(value: number, _name, entry) => [
              `${value.toFixed(1)}% · ${(entry.payload as TrendPoint).runs} runs`,
              'Pass rate',
            ]}
          />
          <Line
            type="monotone"
            dataKey="passRate"
            stroke="var(--accent)"
            strokeWidth={2}
            dot={{ r: 3, fill: 'var(--accent)' }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

const suiteColumnHelper = createColumnHelper<SuiteBreakdown>();
function makeSuiteColumns(project: string) {
  return [
    suiteColumnHelper.accessor('suite', {
      header: 'Suite',
      // The number is the question; the runs behind it are the answer. Links
      // straight to those runs rather than making the reader re-filter by hand.
      cell: (info) => (
        <span className={styles.suiteCell}>
          <Link className={styles.rowLink} to={`/execution?project=${encodeURIComponent(project)}&suite=${encodeURIComponent(info.getValue())}`}>
            {info.getValue()}
          </Link>
          {/* Two rows can share a name — a Cucumber tag and a feature path
              select different test sets and are tracked separately — so
              without this the table would show what looks like a duplicate. */}
          {info.row.original.suiteKind ? (
            <span className={styles.suiteKind}>{SUITE_KIND_LABELS[info.row.original.suiteKind]}</span>
          ) : null}
        </span>
      ),
    }),
    suiteColumnHelper.accessor('passRate', {
      header: 'Pass rate',
      cell: (info) => <PassRateCell passRate={info.getValue()} runs={info.row.original.runs} />,
    }),
  ];
}

function SuiteBreakdownTable({ rows, project }: { rows: SuiteBreakdown[]; project: string }) {
  const [sorting, setSorting] = useState<SortingState>([{ id: 'passRate', desc: false }]);
  const data = useMemo(() => rows, [rows]);
  const columns = useMemo(() => makeSuiteColumns(project), [project]);
  const table = useReactTable({
    data,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  if (rows.length === 0) return <p className={styles.none}>No suite data.</p>;

  return (
    <Table>
      <Thead>
        {table.getHeaderGroups().map((headerGroup) => (
          <Tr key={headerGroup.id}>
            {headerGroup.headers.map((header) => (
              <Th
                key={header.id}
                onSort={header.column.getCanSort() ? () => header.column.toggleSorting() : undefined}
                sort={header.column.getIsSorted() || false}
              >
                {flexRender(header.column.columnDef.header, header.getContext())}
              </Th>
            ))}
          </Tr>
        ))}
      </Thead>
      <Tbody>
        {table.getRowModel().rows.map((row) => (
          <Tr key={row.id}>
            {row.getVisibleCells().map((cell) => (
              <Td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</Td>
            ))}
          </Tr>
        ))}
      </Tbody>
    </Table>
  );
}

/**
 * The run list filtered to one device. Carries the host: a udid alone would
 * also match every other host's device with the same serial (`emulator-5554`).
 * Rows aggregated before analytics recorded a host have none, and link by
 * udid only rather than not at all.
 */
function deviceRunsHref(udid: string, machineId: string | undefined): string {
  const params = new URLSearchParams({ deviceUdid: udid });
  if (machineId) params.set('machineId', machineId);
  return `/execution?${params.toString()}`;
}

const deviceColumnHelper = createColumnHelper<DeviceBreakdown>();
const deviceColumns = [
  deviceColumnHelper.accessor('deviceUdid', {
    header: 'Device',
    cell: (info) => (
      <>
        <Link className={styles.rowLink} to={deviceRunsHref(info.getValue(), info.row.original.machineId)}>
          <Mono>{info.getValue()}</Mono>
        </Link>
        {info.row.original.machineId && <span className={styles.deviceHost}> · {info.row.original.machineId}</span>}
      </>
    ),
  }),
  deviceColumnHelper.accessor('passRate', {
    header: 'Pass rate',
    cell: (info) => <PassRateCell passRate={info.getValue()} runs={info.row.original.runs} />,
  }),
];

function DeviceBreakdownTable({ rows }: { rows: DeviceBreakdown[] }) {
  const [sorting, setSorting] = useState<SortingState>([{ id: 'passRate', desc: false }]);
  const data = useMemo(() => rows, [rows]);
  const table = useReactTable({
    data,
    columns: deviceColumns,
    // Same udid on two hosts is two devices — key rows by both.
    getRowId: (row) => `${row.machineId ?? ''}:${row.deviceUdid}`,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  if (rows.length === 0) return <p className={styles.none}>No device data.</p>;

  return (
    <Table>
      <Thead>
        {table.getHeaderGroups().map((headerGroup) => (
          <Tr key={headerGroup.id}>
            {headerGroup.headers.map((header) => (
              <Th
                key={header.id}
                onSort={header.column.getCanSort() ? () => header.column.toggleSorting() : undefined}
                sort={header.column.getIsSorted() || false}
              >
                {flexRender(header.column.columnDef.header, header.getContext())}
              </Th>
            ))}
          </Tr>
        ))}
      </Thead>
      <Tbody>
        {table.getRowModel().rows.map((row) => (
          <Tr key={row.id}>
            {row.getVisibleCells().map((cell) => (
              <Td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</Td>
            ))}
          </Tr>
        ))}
      </Tbody>
    </Table>
  );
}

/**
 * All periods for one project/platform, newest first.
 *
 * Grouped rather than rendered one section per aggregate: a project with a
 * week of history previously produced seven near-identical sections, which
 * buried the comparison the page exists to make. The latest period drives the
 * headline numbers; the rest become the trend.
 */
interface AggregateGroup {
  key: string;
  project: string;
  platform: AnalyticsAggregate['platform'];
  latest: AnalyticsAggregate;
  trend: TrendPoint[];
}

interface TrendPoint {
  label: string;
  passRate: number;
  runs: number;
}

function groupAggregates(aggregates: AnalyticsAggregate[]): AggregateGroup[] {
  const groups = new Map<string, AnalyticsAggregate[]>();
  for (const a of aggregates) {
    const key = `${a.project}::${a.platform}`;
    groups.set(key, [...(groups.get(key) ?? []), a]);
  }

  return [...groups.entries()].map(([key, items]) => {
    const byDateDesc = [...items].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    return {
      key,
      project: byDateDesc[0].project,
      platform: byDateDesc[0].platform,
      latest: byDateDesc[0],
      // Oldest first so the line reads left-to-right the way time does.
      trend: [...byDateDesc].reverse().map((a) => ({
        label: new Date(a.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
        passRate: Number((a.passRate * 100).toFixed(1)),
        runs: a.totalRuns,
      })),
    };
  });
}

function AggregateSection({ group }: { group: AggregateGroup }) {
  const { latest } = group;
  // Scoped to exactly what this section summarises, so the link lands on the
  // same population the numbers above it were computed from.
  const runsHref = `/execution?project=${encodeURIComponent(group.project)}`;

  return (
    <section className={styles.section}>
      <header className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>{group.project}</h2>
        <span className={styles.platform}>{platformLabel(group.platform)}</span>
        <span className={styles.computed}>Computed {formatRelative(latest.computedAt)}</span>
        <Link className={styles.sectionLink} to={runsHref}>
          View runs →
        </Link>
      </header>

      <div className={styles.kpis}>
        <Kpi label="Total runs" value={String(latest.totalRuns)} />
        <Kpi label="Pass rate" value={formatPercent(latest.passRate)} tone={passRateTone(latest.passRate)} sub="by run" />
        {/* Shown only when something actually reported tests. A hardcoded
            "0%" beside a real run-level rate would read as a catastrophe
            rather than as an absence, which is the whole reason the backend
            tracks runsWithTestResults separately. */}
        {latest.runsWithTestResults > 0 ? (
          <Kpi
            label="Test pass rate"
            value={formatPercent(latest.testPassRate)}
            tone={passRateTone(latest.testPassRate)}
            sub={`${latest.passedTests}/${latest.totalTests} tests`}
          />
        ) : null}
        <Kpi label="Failed" value={String(latest.failedRuns)} tone="var(--status-failed)" />
        <Kpi label="Avg duration" value={formatAvgDuration(latest.avgDurationMs)} />
      </div>

      <Card>
        <CardBody>
          <div className={styles.breakdownTitle}>Pass rate over time</div>
          <PassRateTrend points={group.trend} />
        </CardBody>
      </Card>

      <div className={styles.breakdowns}>
        <Card>
          <CardBody>
            <div className={styles.breakdownTitle}>By suite</div>
            <SuiteBreakdownTable rows={latest.bySuite} project={group.project} />
          </CardBody>
        </Card>

        <Card>
          <CardBody>
            <div className={styles.breakdownTitle}>By device</div>
            <DeviceBreakdownTable rows={latest.byDevice} />
          </CardBody>
        </Card>
      </div>
    </section>
  );
}

/**
 * The most recent runs behind these aggregates.
 *
 * Aggregates answer "how are we doing"; this answers "what just happened",
 * which is the question someone actually opens this page with after a failure.
 * Every row links to the run.
 */
function RecentRuns({ project }: { project?: string }) {
  const { data: runs } = useExecutionRuns(project ? { project } : {});
  const recent = runs?.slice(0, 8) ?? [];
  if (recent.length === 0) return null;

  return (
    <Card>
      <CardBody>
        <div className={styles.breakdownTitle}>Latest runs</div>
        <ul className={styles.recentList}>
          {recent.map((run) => (
            <li key={run._id}>
              <Link className={styles.recentRow} to={`/execution/${run._id}`}>
                <StatusBadge status={run.status} bare />
                <span className={styles.recentSuite}>{run.suite}</span>
                <span className={styles.recentMeta}>{run.project}</span>
                <span className={styles.recentWhen}>{formatRelative(run.endedAt ?? run.createdAt)}</span>
              </Link>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}

/**
 * "What fails repeatedly" over a trailing window — a different question from
 * "what failed on this run" (RunDetailPage's own per-run breakdown). Grouped
 * server-side on a normalized signature so the same failure with a different
 * run id/port/timestamp counts as one entry, not one per occurrence.
 */
function FailureReasons({ project, platform }: { project?: string; platform?: 'android' | 'ios' | 'all' }) {
  const { data } = useFailureReasons({ project, platform });
  const reasons = data?.reasons.slice(0, 8) ?? [];
  if (reasons.length === 0) return null;

  return (
    <Card>
      <CardBody>
        <div className={styles.breakdownTitle}>Recurring failures (last 30 days)</div>
        <ul className={styles.recentList}>
          {reasons.map((r) => (
            <li key={r.signature} className={styles.recentRow}>
              <Mono className={styles.failureCount}>{r.count}&times;</Mono>
              <span className={styles.recentSuite}>{r.message}</span>
              <span className={styles.recentWhen}>
                {r.runCount === 1 ? '1 run' : `${r.runCount} runs`} · last {formatRelative(r.lastSeenAt)}
              </span>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}

/**
 * What fraction of the window each device spent busy vs idle — a
 * capacity-planning question ("do we need more devices") distinct from
 * pass-rate/duration, which answer "is the app healthy" instead.
 */
function DeviceUtilisation({ project, platform }: { project?: string; platform?: 'android' | 'ios' | 'all' }) {
  const { data } = useDeviceUtilisation({ project, platform });
  const rows = data?.slice(0, 8) ?? [];
  if (rows.length === 0) return null;

  return (
    <Card>
      <CardBody>
        <div className={styles.breakdownTitle}>Device utilisation</div>
        <ul className={styles.recentList}>
          {rows.map((r) => (
            <li key={`${r.machineId}:${r.deviceUdid}`} className={styles.recentRow}>
              <span className={styles.rateBar}>
                <ProgressBar value={r.utilisation * 100} />
              </span>
              <Link className={styles.recentSuite} to={deviceRunsHref(r.deviceUdid, r.machineId)}>
                <Mono>{r.deviceUdid}</Mono>
                <span className={styles.deviceHost}> · {r.machineId}</span>
              </Link>
              <span className={styles.recentWhen}>
                {formatPercent(r.utilisation)} busy · {r.runs} runs
              </span>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}

/**
 * Flakiness grouped by the full run configuration (suite+platform+branch),
 * not just suite — see analytics.service.ts's `computeFlakinessByConfigTuple`
 * doc comment for why this is a distinct, additive measure from the
 * suite-level one already shown per project section above.
 */
function ConfigFlakiness({ project, platform }: { project?: string; platform?: 'android' | 'ios' | 'all' }) {
  const { data } = useConfigFlakiness({ project, platform });
  const rows = (data ?? []).filter((r) => r.flakiness > 0).slice(0, 8);
  if (rows.length === 0) return null;

  return (
    <Card>
      <CardBody>
        <div className={styles.breakdownTitle}>Flaky configurations (suite + branch)</div>
        <ul className={styles.recentList}>
          {rows.map((r) => (
            <li key={`${r.project}::${r.platform}::${r.suite}::${r.branch}`} className={styles.recentRow}>
              <span className={styles.recentSuite}>
                {r.suite} <Mono>{r.branch}</Mono>
              </span>
              <span className={styles.recentWhen}>
                {formatPercent(r.passRate)} pass · {r.runs} runs · flakiness {r.flakiness.toFixed(2)}
              </span>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}

/**
 * Which one named test — not which suite or configuration bucket — is
 * alternating pass/fail across recent runs. The most actionable of the three
 * flakiness granularities, since it names the specific test to look at.
 */
function TestCaseFlakiness({ project, platform }: { project?: string; platform?: 'android' | 'ios' | 'all' }) {
  const { data } = useTestCaseFlakiness({ project, platform });
  const rows = data?.slice(0, 8) ?? [];
  if (rows.length === 0) return null;

  return (
    <Card>
      <CardBody>
        <div className={styles.breakdownTitle}>Flaky tests</div>
        <ul className={styles.recentList}>
          {rows.map((r) => (
            <li key={`${r.project}::${r.platform}::${r.suite}::${r.branch}::${r.testId}`} className={styles.recentRow}>
              <span className={styles.recentSuite}>{r.testName}</span>
              <span className={styles.recentWhen}>
                {r.recentStatuses.join(' → ')} · {r.alternations} flip{r.alternations === 1 ? '' : 's'}
              </span>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}

export function AnalyticsPage() {
  const { project, setProject, platform, setPlatform, window, setWindow } = useAnalyticsFilters();
  // 'all' is the cross-platform rollup; picking a specific platform switches
  // to that platform's own aggregate instead of the always-'all' one.
  const {
    data: aggregates,
    isPending,
    error,
    refetch,
  } = useAnalytics({ project: project || undefined, platform, window });
  const filtered = project !== '' || platform !== 'all' || window !== 'daily';
  const groups = useMemo(() => groupAggregates(aggregates ?? []), [aggregates]);

  return (
    <Page>
      <PageHeader
        title="Analytics"
        subtitle={
          window === 'weekly'
            ? 'Weekly rollups of execution runs, recomputed daily.'
            : 'Daily rollups of execution runs, recomputed hourly.'
        }
      />

      <AnalyticsFilterBar
        project={project}
        onProjectChange={setProject}
        platform={platform}
        onPlatformChange={setPlatform}
        window={window}
        onWindowChange={setWindow}
      />

      <QueryBoundary
        isPending={isPending}
        error={error}
        isEmpty={aggregates?.length === 0}
        onRetry={() => void refetch()}
        empty={
          filtered ? (
            <EmptyState
              icon={icons.analytics}
              title="No aggregates match these filters"
              body="Try a different project or platform, or clear the filters to see everything computed so far."
            />
          ) : (
            <EmptyState
              icon={icons.analytics}
              title="Nothing to report yet"
              body="Aggregates are computed from completed execution runs. Once runs finish, pass rates and device breakdowns appear here."
            />
          )
        }
      >
        <div className={styles.sections}>
          {groups.map((g) => (
            <AggregateSection key={g.key} group={g} />
          ))}
          <RecentRuns project={project || undefined} />
          <FailureReasons project={project || undefined} platform={platform} />
          <DeviceUtilisation project={project || undefined} platform={platform} />
          <ConfigFlakiness project={project || undefined} platform={platform} />
          <TestCaseFlakiness project={project || undefined} platform={platform} />
        </div>
      </QueryBoundary>
    </Page>
  );
}
