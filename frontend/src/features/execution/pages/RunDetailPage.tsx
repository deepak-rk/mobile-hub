import { Link, useParams } from 'react-router-dom';
import { Button, Card, CardBody, DescriptionList, Mono, Page, PageHeader, QueryBoundary } from 'react-design-kit';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { icons, iconSize } from '@/lib/icons';
import { formatDurationBetween, formatRelative } from 'ts-format-utils';
import { isInFlight, useCancelRun, useExecutionRun, useRunLog } from '../api/execution.api';
import { useRunStream } from '../api/useRunStream';
import { LogViewer } from '../components/LogViewer';
import { useAuth } from '@/features/auth/useAuth';
import { STAGE_LABELS, stageColor, stageIcon } from '../lib/stageMeta';
import styles from './RunDetailPage.module.css';

/**
 * Reads back what the backend recorded about *why* a run failed. Phrased so
 * the distinction is obvious to someone triaging: only 'test' is a verdict on
 * the application; the other two say the run never got a fair chance.
 */
const FAILURE_KIND_LABELS: Record<string, string> = {
  test: 'Test failure — the suite reported failures',
  infra: 'Infrastructure — the run could not complete (not counted in pass rate)',
  precondition: 'Precondition — the run never started (not counted in pass rate)',
};

/**
 * Artifact links are plain `<a>` elements, not axios calls: the report is a
 * static HTML tree the browser must load in its own right, and the log
 * download is a stream the browser should save without the tab buffering it.
 * Both need the same origin axios uses — the `/api` prefix is always appended,
 * never replaced (see services/api.ts).
 */
function artifactUrl(runId: string, suffix: string): string {
  return `${import.meta.env.VITE_API_URL ?? ''}/api/execution/${runId}/${suffix}`;
}

export function RunDetailPage() {
  const { runId } = useParams<{ runId: string }>();
  const { can } = useAuth();
  // Always attempt the stream: the hook itself reports 'unauthenticated' when
  // there's no token, which the viewer shows as "sign in to stream logs".
  // Gating on the user here instead would render an idle "waiting for
  // output..." that wrongly implies output might still arrive.
  const { state: streamState, logLines } = useRunStream(runId);
  const { data: run, isPending, error, refetch } = useExecutionRun(runId, streamState === 'live');

  // Fall back to the stored log whenever the live stream isn't carrying this
  // run's output — which is every already-finished run. Without this the panel
  // sat on "Waiting for output…" forever despite the log existing on disk.
  const { data: storedLog } = useRunLog(runId, streamState !== 'live' && logLines.length === 0);
  const lines = logLines.length > 0 ? logLines : storedLog ? [storedLog] : [];
  // Only offer the download once something has proven a log exists: either the
  // stored copy came back, or lines are arriving live (which means the file is
  // being written right now). A run whose log fetch 404s shows no control at
  // all, rather than a link that fails when clicked.
  const hasStoredLog = Boolean(storedLog) || logLines.length > 0;
  const cancel = useCancelRun(runId ?? '');

  // Cancel is only meaningful while the run is non-terminal, and only for
  // roles the backend will actually accept (guidelines §10).
  const showCancel = run ? isInFlight(run.status) && can('operator', 'admin') : false;

  return (
    <Page>
      <PageHeader
        title={run ? `${run.project} · ${run.suite}` : 'Run'}
        subtitle={runId}
        actions={
          <>
            {/* Both artifact controls are hidden, never disabled, when the
                artifact does not exist — offering a link that 404s is the
                dead-button case the guidelines forbid. `reportPath` is only
                set for a report with a real index.html, and the log link waits
                for the same fetch that feeds the viewer below. */}
            {run?.reportPath && runId ? (
              <a href={artifactUrl(runId, 'report')} target="_blank" rel="noreferrer">
                <Button size="sm" variant="secondary">
                  <icons.analytics size={iconSize.control} aria-hidden="true" />
                  Open report
                </Button>
              </a>
            ) : null}
            {hasStoredLog && runId ? (
              <a href={artifactUrl(runId, 'logs?download=1')} download>
                <Button size="sm" variant="ghost">
                  <icons.downloading size={iconSize.control} aria-hidden="true" />
                  Download log
                </Button>
              </a>
            ) : null}
            {showCancel ? (
              <Button
                size="sm"
                variant="destructive"
                onClick={() => cancel.mutate()}
                disabled={cancel.isPending}
              >
                <icons.cancelled size={iconSize.control} aria-hidden="true" />
                {cancel.isPending ? 'Cancelling…' : 'Cancel run'}
              </Button>
            ) : null}
            <Link to="/execution">
              <Button size="sm" variant="ghost">
                Back to runs
              </Button>
            </Link>
          </>
        }
      />

      <QueryBoundary isPending={isPending} error={error} onRetry={() => void refetch()} skeletonCount={2}>
        {run ? (
          <div className={styles.split}>
            <Card>
              <CardBody>
                <div className={styles.panelHead}>
                  <span className={styles.panelTitle}>Pipeline</span>
                  <StatusBadge status={run.status} />
                </div>

                <ol className={styles.stages}>
                  {run.stages.map((stage) => {
                    const Icon = stageIcon(stage.status);
                    const isRunning = stage.status === 'running';
                    return (
                      <li key={stage.name} className={styles.stage}>
                        <span
                          className={`${styles.stageIcon} ${isRunning ? styles.pulse : ''}`}
                          style={{ color: stageColor(stage.status) }}
                        >
                          <Icon size={iconSize.control} aria-hidden="true" />
                        </span>
                        <span className={styles.stageBody}>
                          <span className={styles.stageName}>{STAGE_LABELS[stage.name]}</span>
                          <span className={styles.stageMeta}>
                            {stage.status}
                            {stage.startedAt ? ` · ${formatDurationBetween(stage.startedAt, stage.endedAt)}` : ''}
                          </span>
                          {stage.error ? <span className={styles.stageError}>{stage.error}</span> : null}
                        </span>
                      </li>
                    );
                  })}
                </ol>

                <LogViewer lines={lines} streamState={streamState} />
              </CardBody>
            </Card>

            <Card>
              <CardBody>
                <div className={styles.panelHead}>
                  <span className={styles.panelTitle}>Details</span>
                </div>
                <DescriptionList
                  items={[
                    { term: 'Project', value: run.project },
                    // Only meaningful on a failure, and worth showing there:
                    // "the device was busy" and "the tests failed" look
                    // identical without it.
                    ...(run.status === 'failed' && run.failureKind
                      ? [{ term: 'Failure', value: FAILURE_KIND_LABELS[run.failureKind] }]
                      : []),
                    { term: 'Branch', value: <Mono>{run.branch}</Mono> },
                    { term: 'Suite', value: <Mono>{run.suite}</Mono> },
                    {
                      term: 'Device',
                      value: (
                        <Link className={styles.deviceLink} to={`/devices/${run.deviceUdid}`}>
                          <Mono>{run.deviceUdid}</Mono>
                        </Link>
                      ),
                    },
                    { term: 'Host', value: <Mono>{run.machineId}</Mono> },
                    { term: 'Duration', value: formatDurationBetween(run.startedAt, run.endedAt) },
                    { term: 'Started', value: formatRelative(run.startedAt) },
                    { term: 'Ended', value: run.endedAt ? formatRelative(run.endedAt) : '—' },
                  ]}
                />
              </CardBody>
            </Card>
          </div>
        ) : null}
      </QueryBoundary>
    </Page>
  );
}
