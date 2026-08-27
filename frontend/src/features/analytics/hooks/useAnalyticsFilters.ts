import { useEffect, useState } from 'react';
import { useSearchParamsState } from 'react-design-kit';
import type { AnalyticsPlatformFilter } from '../components/AnalyticsFilterBar';

const PROJECT_DEBOUNCE_MS = 300;

/**
 * URL-synced analytics filters, backed by `GET /api/analytics`'s real
 * `project`/`platform` query params — same pattern as `useDeviceFilters` and
 * `useRunFilters`. `project` is free text and debounced for the same reason
 * as the execution filter: the input updates instantly, the URL (and the
 * query it drives) only after typing pauses.
 *
 * `window` isn't exposed here even though the backend's schema accepts it —
 * only `daily` aggregates are ever computed (see docs/TODO.md), so a
 * user-facing toggle would offer a `weekly` option that always returns
 * nothing. Not built rather than shipped as a dead control.
 */
export function useAnalyticsFilters() {
  const [urlProject, setUrlProject] = useSearchParamsState('project', '');
  const [project, setProjectInput] = useState(urlProject);
  const [platform, setPlatform] = useSearchParamsState('platform', 'all');

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
  };
}
