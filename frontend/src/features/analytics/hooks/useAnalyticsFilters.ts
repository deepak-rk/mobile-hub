import { useSearchParamsState } from 'react-design-kit';
import type { AnalyticsPlatformFilter, AnalyticsWindow } from '../components/AnalyticsFilterBar';

/**
 * URL-synced analytics filters, backed by `GET /api/analytics`'s real
 * `project`/`platform`/`window` query params — same pattern as
 * `useDeviceFilters` and `useRunFilters`.
 *
 * `project` used to be debounced free text. It is a `<select>` now, so the
 * debounce went with it: a selection is a discrete event, and delaying it by
 * 300ms only made the chart lag the control. The trigger form already picked
 * projects from a list, so leaving this as free text meant the two screens
 * disagreed about whether a project is an enumerable thing.
 *
 * `window` defaults to `daily`. Both `daily` and `weekly` aggregates are
 * real — `computeWeeklyAggregates` runs on its own schedule in
 * `server.ts`, same as the daily one — this used to be a dead control
 * (weekly was never computed) but isn't anymore; see docs/LESSONS.md.
 */
export function useAnalyticsFilters() {
  const [project, setProject] = useSearchParamsState('project', '');
  const [platform, setPlatform] = useSearchParamsState('platform', 'all');
  const [window, setWindow] = useSearchParamsState('window', 'daily');

  return {
    project,
    setProject: (v: string) => setProject(v),
    platform: platform as AnalyticsPlatformFilter,
    setPlatform: (v: AnalyticsPlatformFilter) => setPlatform(v),
    window: window as AnalyticsWindow,
    setWindow: (v: AnalyticsWindow) => setWindow(v),
  };
}
