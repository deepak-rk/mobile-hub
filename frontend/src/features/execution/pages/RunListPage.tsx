import { useState } from 'react';
import { Button, EmptyState, Page, PageHeader, QueryBoundary } from 'react-design-kit';
import { useAuth } from '@/features/auth/useAuth';
import { icons, iconSize } from '@/lib/icons';
import { isInFlight, useBulkRunAction, useExecutionRuns, useProjects, type BulkResult } from '../api/execution.api';
import { StatusBoard } from '../components/StatusBoard';
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
  const { project, setProject, deviceUdid, machineId, clearDevice, suite, clearSuite } = useRunFilters();
  const [tab, setTab] = usePipelineTab();
  const { data: runs, isPending, error, refetch } = useExecutionRuns({ project, deviceUdid, machineId, suite });

  const allRuns = runs ?? [];
  const currentRuns = allRuns.filter((r) => isInFlight(r.status));
  const historyRuns = allRuns.filter((r) => !isInFlight(r.status));

  // Bulk actions: hidden, not disabled, for callers who cannot perform them.
  const { can } = useAuth();
  const canAct = can('operator', 'admin');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lastResults, setLastResults] = useState<BulkResult[] | null>(null);
  const bulk = useBulkRunAction();
  const visibleRuns = tab === 'current' ? currentRuns : historyRuns;
  // Only what is on screen counts: a run that moved tabs drops out.
  const chosen = visibleRuns.filter((r) => selected.has(r._id)).map((r) => r._id);
  const changeTab = (next: typeof tab) => {
    setSelected(new Set());
    setLastResults(null);
    setTab(next);
  };
  const runBulk = (action: 'rerun' | 'cancel', failedOnly?: boolean) =>
    bulk.mutate(
      { action, ids: chosen, failedOnly },
      {
        onSuccess: (results) => {
          setLastResults(results);
          setSelected(new Set());
        },
      },
    );
  const selection = canAct
    ? {
        selected,
        onToggle: (id: string) =>
          setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          }),
        onToggleAll: (ids: string[], on: boolean) => setSelected(on ? new Set(ids) : new Set()),
      }
    : undefined;
  const refused = lastResults?.filter((r) => !r.ok) ?? [];

  // The board shows one project: the filter's, else the first declared one.
  const { data: projects } = useProjects();
  const boardProject = project || projects?.find((p) => p.declared)?.id || '';

  return (
    <Page>
      <PageHeader
        title="Execution"
        subtitle="Trigger runs, watch what's in flight, and review history."
        actions={
          tab !== 'trigger' ? (
            <Button variant="primary" size="sm" onClick={() => changeTab('trigger')}>
              <icons.running size={iconSize.control} aria-hidden="true" />
              Trigger a run
            </Button>
          ) : undefined
        }
      />

      <PipelineTabs
        active={tab}
        onChange={changeTab}
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
      ) : tab === 'board' ? (
        boardProject ? (
          <StatusBoard project={boardProject} />
        ) : (
          <EmptyState
            icon={icons.execution}
            title="No project to show"
            body="Declare a project in the org config, or trigger a run, and its scenarios appear here."
          />
        )
      ) : (
        <>
          <RunFilterBar
            project={project}
            onProjectChange={setProject}
            device={deviceUdid ? { udid: deviceUdid, machineId } : null}
            onClearDevice={clearDevice}
            suite={suite}
            onClearSuite={clearSuite}
          />

          {chosen.length > 0 ? (
            <div className={styles.bulkBar} role="region" aria-label="Bulk actions">
              <span>{chosen.length} selected</span>
              {tab === 'current' ? (
                <Button size="sm" variant="secondary" disabled={bulk.isPending} onClick={() => runBulk('cancel')}>
                  Cancel {chosen.length}
                </Button>
              ) : (
                <>
                  <Button size="sm" variant="secondary" disabled={bulk.isPending} onClick={() => runBulk('rerun')}>
                    Re-run {chosen.length}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={bulk.isPending}
                    onClick={() => runBulk('rerun', true)}
                  >
                    Re-run failed tests
                  </Button>
                </>
              )}
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                Clear
              </Button>
            </div>
          ) : null}
          {lastResults ? (
            <div className={styles.bulkResult} role="status">
              {lastResults.length - refused.length} of {lastResults.length} done.
              {refused.length > 0 ? (
                <ul>
                  {refused.map((r) => (
                    <li key={r.id}>
                      <code>{r.id.slice(-8)}</code>: {r.message}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          <QueryBoundary
            isPending={isPending}
            error={error}
            isEmpty={visibleRuns.length === 0}
            onRetry={() => void refetch()}
            empty={
              tab === 'current' ? (
                <EmptyState
                  icon={icons.execution}
                  title="Nothing in flight"
                  body="Trigger a run and it'll show up here while it's queued, preparing, or running."
                />
              ) : project || deviceUdid || suite ? (
                <EmptyState
                  icon={icons.execution}
                  title="No runs match these filters"
                  body="Try a different filter, or clear it to see every finished run."
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
            <RunTable runs={visibleRuns} selection={selection} />
          </QueryBoundary>
        </>
      )}
    </Page>
  );
}
