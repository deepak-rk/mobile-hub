import { Link } from 'react-router-dom';
import {
  Button,
  Card,
  CardBody,
  EmptyState,
  List,
  Meta,
  MetaSep,
  Mono,
  Page,
  PageHeader,
  QueryBoundary,
} from 'react-design-kit';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { icons, iconSize } from '@/lib/icons';
import { formatDurationBetween, formatRelative } from 'ts-format-utils';
import { useExecutionRuns } from '../api/execution.api';
import styles from './RunListPage.module.css';

export function RunListPage() {
  const { data: runs, isPending, error, refetch } = useExecutionRuns();

  return (
    <Page>
      <PageHeader
        title="Execution runs"
        subtitle="Test runs dispatched to devices, newest first."
        actions={
          <Link to="/execution/new">
            <Button variant="primary" size="sm">
              <icons.running size={iconSize.control} aria-hidden="true" />
              Trigger a run
            </Button>
          </Link>
        }
      />

      <QueryBoundary
        isPending={isPending}
        error={error}
        isEmpty={runs?.length === 0}
        onRetry={() => void refetch()}
        empty={
          <EmptyState
            icon={icons.execution}
            title="No runs yet"
            body="When a run is triggered it locks a device, executes its suite, and streams stage and log events here in real time."
          />
        }
      >
        <List>
          {runs?.map((run) => (
            <Card key={run._id} interactive>
              <CardBody>
                <Link to={`/execution/${run._id}`} className={styles.link}>
                  <div className={styles.head}>
                    <span className={styles.project}>{run.project}</span>
                    <span className={styles.suite}>{run.suite}</span>
                    <StatusBadge status={run.status} />
                  </div>
                  <Meta>
                    <span className={styles.branch}>
                      <icons.execution size={iconSize.dense} aria-hidden="true" />
                      {run.branch}
                    </span>
                    <MetaSep />
                    <Mono>{run.deviceUdid}</Mono>
                    <MetaSep />
                    <span>{formatDurationBetween(run.startedAt, run.endedAt)}</span>
                    <MetaSep />
                    <span>{formatRelative(run.createdAt)}</span>
                  </Meta>
                </Link>
              </CardBody>
            </Card>
          ))}
        </List>
      </QueryBoundary>
    </Page>
  );
}
