import { Link, useParams } from 'react-router-dom';
import { Card, CardBody, DescriptionList, Mono, Page, PageHeader } from '@/components/ui/layout';
import { Button } from '@/components/ui/Button';
import { QueryBoundary } from '@/components/ui/states';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { icons, iconSize } from '@/lib/icons';
import { formatDuration, formatRelative } from '@/lib/format';
import { useExecutionRun } from '../api/execution.api';
import type { RunStage } from '../types';
import styles from './RunDetailPage.module.css';

const STAGE_LABELS: Record<RunStage['name'], string> = {
  pulling: 'Pull repository',
  restoring_cache: 'Restore cache',
  installing: 'Install dependencies',
  execute: 'Execute suite',
};

function stageIcon(status: RunStage['status']) {
  if (status === 'done') return icons.passed;
  if (status === 'error') return icons.failed;
  if (status === 'running') return icons.running;
  if (status === 'skipped') return icons.cancelled;
  return icons.dot;
}

function stageColor(status: RunStage['status']): string {
  if (status === 'done') return 'var(--status-passed)';
  if (status === 'error') return 'var(--status-failed)';
  if (status === 'running') return 'var(--status-running)';
  return 'var(--text-disabled)';
}

export function RunDetailPage() {
  const { runId } = useParams<{ runId: string }>();
  const { data: run, isPending, error, refetch } = useExecutionRun(runId);

  return (
    <Page>
      <PageHeader
        title={run ? `${run.project} · ${run.suite}` : 'Run'}
        subtitle={runId}
        actions={
          <Link to="/execution">
            <Button size="sm" variant="ghost">
              Back to runs
            </Button>
          </Link>
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
                            {stage.startedAt ? ` · ${formatDuration(stage.startedAt, stage.endedAt)}` : ''}
                          </span>
                          {stage.error ? <span className={styles.stageError}>{stage.error}</span> : null}
                        </span>
                      </li>
                    );
                  })}
                </ol>

                {/* The backend streams live stage/log events over
                    GET /api/execution/:id/stream. Consuming that needs an
                    authenticated token, which requires the login screen that
                    doesn't exist yet — so this polls and says so, rather than
                    pretending to be live. */}
                <p className={styles.note}>
                  Polling for updates. Live log streaming becomes available once sign-in is implemented.
                </p>
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
                    { term: 'Duration', value: formatDuration(run.startedAt, run.endedAt) },
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
