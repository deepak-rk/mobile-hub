import { useMemo, useState } from 'react';
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
import { useAnalytics } from '../api/analytics.api';
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

function Kpi({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <Card>
      <CardBody>
        <div className={styles.kpiLabel}>{label}</div>
        <div className={styles.kpiValue} style={tone ? { color: tone } : undefined}>
          {value}
        </div>
      </CardBody>
    </Card>
  );
}

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

const suiteColumnHelper = createColumnHelper<SuiteBreakdown>();
const suiteColumns = [
  suiteColumnHelper.accessor('suite', { header: 'Suite' }),
  suiteColumnHelper.accessor('passRate', {
    header: 'Pass rate',
    cell: (info) => <PassRateCell passRate={info.getValue()} runs={info.row.original.runs} />,
  }),
];

function SuiteBreakdownTable({ rows }: { rows: SuiteBreakdown[] }) {
  const [sorting, setSorting] = useState<SortingState>([{ id: 'passRate', desc: false }]);
  const data = useMemo(() => rows, [rows]);
  const table = useReactTable({
    data,
    columns: suiteColumns,
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

const deviceColumnHelper = createColumnHelper<DeviceBreakdown>();
const deviceColumns = [
  deviceColumnHelper.accessor('deviceUdid', {
    header: 'Device',
    cell: (info) => <Mono>{info.getValue()}</Mono>,
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

function AggregateSection({ aggregate }: { aggregate: AnalyticsAggregate }) {
  return (
    <section className={styles.section}>
      <header className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>{aggregate.project}</h2>
        <span className={styles.platform}>{platformLabel(aggregate.platform)}</span>
        <span className={styles.computed}>Computed {formatRelative(aggregate.computedAt)}</span>
      </header>

      <div className={styles.kpis}>
        <Kpi label="Total runs" value={String(aggregate.totalRuns)} />
        <Kpi label="Pass rate" value={formatPercent(aggregate.passRate)} tone={passRateTone(aggregate.passRate)} />
        <Kpi label="Failed" value={String(aggregate.failedRuns)} tone="var(--status-failed)" />
        <Kpi label="Avg duration" value={formatAvgDuration(aggregate.avgDurationMs)} />
      </div>

      <div className={styles.breakdowns}>
        <Card>
          <CardBody>
            <div className={styles.breakdownTitle}>By suite</div>
            <SuiteBreakdownTable rows={aggregate.bySuite} />
          </CardBody>
        </Card>

        <Card>
          <CardBody>
            <div className={styles.breakdownTitle}>By device</div>
            <DeviceBreakdownTable rows={aggregate.byDevice} />
          </CardBody>
        </Card>
      </div>
    </section>
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
          {aggregates?.map((a) => (
            <AggregateSection key={a._id} aggregate={a} />
          ))}
        </div>
        <p className={styles.footnote}>
          Trend charts arrive once there are multiple days of aggregates to plot — a line through a single point
          would be noise, not insight.
        </p>
      </QueryBoundary>
    </Page>
  );
}
