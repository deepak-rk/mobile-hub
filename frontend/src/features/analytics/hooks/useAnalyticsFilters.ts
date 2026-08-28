import { useEffect, useState } from 'react';
import { useSearchParamsState } from 'react-design-kit';
import type { AnalyticsPlatformFilter, AnalyticsWindow } from '../components/AnalyticsFilterBar';

const PROJECT_DEBOUNCE_MS = 300;

/**
 * URL-synced analytics filters, backed by `GET /api/analytics`'s real
 * `project`/`platform`/`window` query params — same pattern as
 * `useDeviceFilters` and `useRunFilters`. `project` is free text and
 * debounced for the same reason as the execution filter: the input updates
 * instantly, the URL (and the query it drives) only after typing pauses.
 *
 * `window` defaults to `daily`. Both `daily` and `weekly` aggregates are
 * real — `computeWeeklyAggregates` runs on its own schedule in
 * `server.ts`, same as the daily one — this used to be a dead control
 * (weekly was never computed) but isn't anymore; see docs/LESSONS.md.
 */
export function useAnalyticsFilters() {
  const [urlProject, setUrlProject] = useSearchParamsState('project', '');
  const [project, setProjectInput] = useState(urlProject);
  const [platform, setPlatform] = useSearchParamsState('platform', 'all');
  const [window, setWindow] = useSearchParamsState('window', 'daily');

  useEffect(() => {
    const timer = setTimeout(() => setUrlProject(project), PROJECT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setUrlProject is stable; only `project` should re-arm the timer.
  }, [project]);

  return {
    project,
    setProject: setProjectInput,
    platform: platform as AnalyticsPlatformFilter,
    setPlatform: (v: AnalyticsPlatformFilter) => setPlatform(v),
    window: window as AnalyticsWindow,
    setWindow: (v: AnalyticsWindow) => setWindow(v),
  };
}
