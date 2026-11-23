import { Link } from 'react-router-dom';
import { Button, Card, CardBody, EmptyState, QueryBoundary } from 'react-design-kit';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { icons } from '@/lib/icons';
import { formatRelative } from 'ts-format-utils';
import { useAuth } from '@/features/auth/useAuth';
import { useClearStuck, useStatusTree } from '../api/execution.api';
import { boardBadge } from '../lib/boardStatus';
import styles from './StatusBoard.module.css';

/** How many of the last results to show as a strip, newest last. */
const HISTORY_SHOWN = 10;

/**
 * Where every scenario of a project stands now, grouped platform × variant →
 * feature → scenario. Built from run results by the backend's board writers;
 * parents show the bubbled-up status of their children.
 */
export function StatusBoard({ project }: { project: string }) {
  const { data, isPending, error, refetch } = useStatusTree(project);
  const clear = useClearStuck(project);
  const { can } = useAuth();
  const groups = data?.groups ?? [];

  return (
    <QueryBoundary
      isPending={isPending}
      error={error}
      onRetry={() => void refetch()}
      isEmpty={groups.length === 0}
      empty={
        <EmptyState
          icon={icons.execution}
          title="Nothing on the board yet"
          body="The board fills in as runs of this project finish, or when a past run is resynced."
        />
      }
    >
      {can('operator', 'admin') ? (
        <div className={styles.actions}>
          <Button size="sm" variant="secondary" disabled={clear.isPending} onClick={() => clear.mutate()}>
            Clear stuck
          </Button>
          {clear.data ? (
            <span role="status" className={styles.note}>
              {clear.data.cleared === 0 ? 'Nothing was stuck.' : `${clear.data.cleared} reset to not run.`}
            </span>
          ) : null}
        </div>
      ) : null}

      {groups.map((g) => (
        <Card key={`${g.platform}:${g.variant ?? ''}`}>
          <CardBody>
            <div className={styles.groupHead}>
              <span className={styles.groupTitle}>
                {g.platform}
                {g.variant ? ` · ${g.variant}` : ''}
              </span>
              <StatusBadge status={boardBadge(g.status)} />
            </div>
            {g.features.map((f) => (
              <details key={f.spec} className={styles.feature} open={f.status !== 'completed'}>
                <summary className={styles.featureHead}>
                  <span className={styles.spec}>{f.spec}</span>
                  <StatusBadge status={boardBadge(f.status)} />
                </summary>
                <ul className={styles.scenarios}>
                  {f.scenarios.map((s) => (
                    <li key={s.testId} className={styles.scenario}>
                      <StatusBadge status={boardBadge(s.status)} />
                      <span className={styles.title}>{s.title}</span>
                      <span className={styles.history} aria-label={`Last ${Math.min(s.history.length, HISTORY_SHOWN)} results`}>
                        {s.history.slice(-HISTORY_SHOWN).map((h, i) => (
                          <Link
                            key={`${h.runId}-${i}`}
                            to={`/execution/${h.runId}`}
                            className={`${styles.dot} ${h.status === 'completed' ? styles.dotPass : styles.dotFail}`}
                            title={`${h.status === 'completed' ? 'Completed' : 'Failed'} ${formatRelative(h.at)}`}
                            aria-label={`${h.status} ${formatRelative(h.at)}`}
                          />
                        ))}
                      </span>
                      <Link to={`/execution/${s.runId}`} className={styles.lastRun}>
                        {formatRelative(s.updatedAt)}
                      </Link>
                    </li>
                  ))}
                </ul>
              </details>
            ))}
          </CardBody>
        </Card>
      ))}
    </QueryBoundary>
  );
}
