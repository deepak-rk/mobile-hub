import { Card, CardBody, Mono, Page, PageHeader, ProgressBar } from '@/components/ui/layout';
import { QueryBoundary, EmptyState } from '@/components/ui/states';
import { icons } from '@/lib/icons';
import { formatPercent, formatRelative } from 'ts-format-utils';
import { useAnalytics } from '../api/analytics.api';
import type { AnalyticsAggregate } from '../types';
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
            {aggregate.bySuite.length === 0 ? (
              <p className={styles.none}>No suite data.</p>
            ) : (
              <ul className={styles.rows}>
                {aggregate.bySuite.map((s) => (
                  <li key={s.suite} className={styles.row}>
                    <span className={styles.rowName}>{s.suite}</span>
                    <span className={styles.rowBar}>
                      <ProgressBar value={s.passRate * 100} tone={passRateTone(s.passRate)} />
                    </span>
                    <span className={styles.rowValue}>
                      {formatPercent(s.passRate)}
                      <span className={styles.rowRuns}>{s.runs} runs</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardBody>
            <div className={styles.breakdownTitle}>By device</div>
            {aggregate.byDevice.length === 0 ? (
              <p className={styles.none}>No device data.</p>
            ) : (
              <ul className={styles.rows}>
                {aggregate.byDevice.map((d) => (
                  <li key={d.deviceUdid} className={styles.row}>
                    <span className={styles.rowName}>
                      <Mono>{d.deviceUdid}</Mono>
                    </span>
                    <span className={styles.rowBar}>
                      <ProgressBar value={d.passRate * 100} tone={passRateTone(d.passRate)} />
                    </span>
                    <span className={styles.rowValue}>
                      {formatPercent(d.passRate)}
                      <span className={styles.rowRuns}>{d.runs} runs</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>
    </section>
  );
}

export function AnalyticsPage() {
  // The 'all' rollup is the cross-platform view; per-platform aggregates exist
  // too but duplicate these numbers whenever only one platform is in play.
  const { data: aggregates, isPending, error, refetch } = useAnalytics({ platform: 'all' });

  return (
    <Page>
      <PageHeader title="Analytics" subtitle="Daily rollups of execution runs, recomputed hourly." />

      <QueryBoundary
        isPending={isPending}
        error={error}
        isEmpty={aggregates?.length === 0}
        onRetry={() => void refetch()}
        empty={
          <EmptyState
            icon={icons.analytics}
            title="Nothing to report yet"
            body="Aggregates are computed from completed execution runs. Once runs finish, pass rates and device breakdowns appear here."
          />
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
