import { Link } from 'react-router-dom';
import { Card, CardBody, EmptyState, Mono } from 'react-design-kit';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { icons, iconSize } from '@/lib/icons';
import { formatRelative } from 'ts-format-utils';
import { useExecutionRun } from '../api/execution.api';
import { useRunStream } from '../api/useRunStream';
import { STAGE_LABELS, stageColor, stageIcon } from '../lib/stageMeta';
import type { ExecutionRun } from '../types';
import styles from './CurrentRunPanel.module.css';

interface CurrentRunPanelProps {
  /** Most recently created non-terminal run, if any — from the same list query the tabs use. */
  latestCurrentRun: ExecutionRun | null;
  /** Most recent terminal runs, newest first, used only when nothing is in flight. */
  recentHistory: ExecutionRun[];
}

/**
 * Fills the space below the trigger form (review point 4): the run in
 * flight, updated live over the same WebSocket `RunDetailPage` uses, or —
 * when nothing is running — a quick look at what happened most recently.
 */
export function CurrentRunPanel({ latestCurrentRun, recentHistory }: CurrentRunPanelProps) {
  if (latestCurrentRun) {
    return <LiveRunCard runId={latestCurrentRun._id} fallback={latestCurrentRun} />;
  }

  if (recentHistory.length === 0) {
    return (
      <Card>
        <CardBody>
          <EmptyState
            icon={icons.execution}
            title="No runs yet"
            body="Trigger a run above — it will show up here while it's in flight, then move to History once it finishes."
          />
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardBody>
        <div className={styles.head}>
          <span className={styles.title}>Recent history</span>
        </div>
        <ul className={styles.list}>
          {recentHistory.map((run) => (
            <li key={run._id} className={styles.row}>
              <Link to={`/execution/${run._id}`} className={styles.rowLink}>
                <StatusBadge status={run.status} bare />
                <span className={styles.meta}>
                  {run.project} · {run.suite}
                </span>
                <span className={styles.time}>{formatRelative(run.createdAt)}</span>
              </Link>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}

/**
 * `fallback` is the run as it came back from the list query, shown
 * immediately; once the WS stream is live the same `useExecutionRun`
 * mechanism `RunDetailPage` uses takes over.
 */
function LiveRunCard({ runId, fallback }: { runId: string; fallback: ExecutionRun }) {
  const { state: streamState } = useRunStream(runId);
  const { data: run } = useExecutionRun(runId, streamState === 'live');
  const active = run ?? fallback;

  return (
    <Card>
      <CardBody>
        <div className={styles.head}>
          <span className={styles.title}>Current run</span>
          <StatusBadge status={active.status} />
        </div>
        <div className={styles.summary}>
          <span>
            {active.project} · {active.suite}
          </span>
          <Mono>{active.deviceUdid}</Mono>
        </div>
        <ol className={styles.stages}>
          {active.stages.map((stage) => {
            const Icon = stageIcon(stage.status);
            return (
              <li key={stage.name} className={styles.stage} style={{ color: stageColor(stage.status) }}>
                <Icon size={iconSize.dense} aria-hidden="true" />
                <span>{STAGE_LABELS[stage.name]}</span>
              </li>
            );
          })}
        </ol>
        <Link to={`/execution/${runId}`} className={styles.viewLink}>
          View full run
        </Link>
      </CardBody>
    </Card>
  );
}
