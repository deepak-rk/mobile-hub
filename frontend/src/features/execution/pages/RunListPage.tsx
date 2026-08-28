import { Button, EmptyState, Page, PageHeader, QueryBoundary } from 'react-design-kit';
import { icons, iconSize } from '@/lib/icons';
import { isInFlight, useExecutionRuns } from '../api/execution.api';
import { CurrentRunPanel } from '../components/CurrentRunPanel';
import { PipelineTabs } from '../components/PipelineTabs';
import { RunFilterBar } from '../components/RunFilterBar';
import { RunTable } from '../components/RunTable';
import { TriggerRunForm } from '../components/TriggerRunForm';
import { useRunFilters } from '../hooks/useRunFilters';
import { usePipelineTab } from '../hooks/usePipelineTab';
import styles from './RunListPage.module.css';

/**
 * The unified execution pipeline page — Trigger / Current / History as tabs
 * on one page (design-gap review point 1), replacing the old split between
 * this file (list) and the standalone `TriggerRunPage` (now a redirect here,
 * see `TriggerRunPage.tsx`).
 *
 * One `GET /execution` query backs every tab: "Current" is whatever isn't
 * terminal yet (`isInFlight`), "History" is everything else, and the History
 * tab's count badge is this same array's real length — no separate count
 * endpoint.
 */
export function RunListPage() {
  const { project, setProject } = useRunFilters();
  const [tab, setTab] = usePipelineTab();
  const { data: runs, isPending, error, refetch } = useExecutionRuns({ project });

  const allRuns = runs ?? [];
  const currentRuns = allRuns.filter((r) => isInFlight(r.status));
  const historyRuns = allRuns.filter((r) => !isInFlight(r.status));

  return (
    <Page>
      <PageHeader
        title="Execution"
        subtitle="Trigger runs, watch what's in flight, and review history."
        actions={
          tab !== 'trigger' ? (
            <Button variant="primary" size="sm" onClick={() => setTab('trigger')}>
              <icons.running size={iconSize.control} aria-hidden="true" />
              Trigger a run
            </Button>
          ) : undefined
        }
      />

      <PipelineTabs
        active={tab}
        onChange={setTab}
        currentCount={currentRuns.length}
        historyCount={historyRuns.length}
      />

      {tab === 'trigger' ? (
        <div className={styles.triggerLayout}>
          <TriggerRunForm />
          <QueryBoundary isPending={isPending} error={error} onRetry={() => void refetch()} skeletonCount={1}>
            <CurrentRunPanel latestCurrentRun={currentRuns[0] ?? null} recentHistory={historyRuns.slice(0, 5)} />
          </QueryBoundary>
        </div>
      ) : (
        <>
          <RunFilterBar project={project} onProjectChange={setProject} />

          <QueryBoundary
            isPending={isPending}
            error={error}
            isEmpty={(tab === 'current' ? currentRuns : historyRuns).length === 0}
            onRetry={() => void refetch()}
            empty={
              tab === 'current' ? (
                <EmptyState
                  icon={icons.execution}
                  title="Nothing in flight"
                  body="Trigger a run and it'll show up here while it's queued, preparing, or running."
                />
              ) : project ? (
                <EmptyState
                  icon={icons.execution}
                  title="No runs match this project"
                  body="Try a different project, or clear the filter to see every finished run."
                />
              ) : (
                <EmptyState
                  icon={icons.execution}
                  title="No runs yet"
                  body="Once a run finishes — passed, failed, or cancelled — it shows up here."
                />
              )
            }
          >
            <RunTable runs={tab === 'current' ? currentRuns : historyRuns} />
          </QueryBoundary>
        </>
      )}
    </Page>
  );
}
