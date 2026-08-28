import { useSearchParamsState } from 'react-design-kit';

export type PipelineTab = 'trigger' | 'current' | 'history';

const VALID_TABS: PipelineTab[] = ['trigger', 'current', 'history'];

/**
 * URL-synced tab selection for the unified execution pipeline page, same
 * idiom as `useDeviceFilters`/`useRunFilters` — a plain button-group backed
 * by one query param rather than a bespoke ARIA tabs widget (there is no
 * `Tabs` primitive in `react-design-kit` or elsewhere in this codebase yet;
 * see docs/ui-guidelines.md §9, still to build).
 *
 * Defaults to 'current' — landing on `/execution` shows what's happening
 * right now, which is the most actionable view; `?tab=trigger`/`history`
 * (or clicking a tab) switch it, and an unrecognised value falls back to
 * the default instead of rendering nothing.
 */
export function usePipelineTab(): [PipelineTab, (next: PipelineTab) => void] {
  const [tab, setTab] = useSearchParamsState('tab', 'current');
  const active = VALID_TABS.includes(tab as PipelineTab) ? (tab as PipelineTab) : 'current';
  return [active, (next: PipelineTab) => setTab(next)];
}
