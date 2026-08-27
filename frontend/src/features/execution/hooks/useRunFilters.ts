import { useEffect, useState } from 'react';
import { useSearchParamsState } from 'react-design-kit';
import type { RunStatusFilter } from '../components/RunFilterBar';

const PROJECT_DEBOUNCE_MS = 300;

/**
 * URL-synced run filters, backed by the same query params `GET /api/execution`
 * already accepts server-side (`status`, `project`) — filtering happens on
 * the backend, matching the same pattern `useDeviceFilters` established.
 *
 * `project` is free text (there's no fixed list of project names to offer as
 * a dropdown), so it's debounced: the input reflects every keystroke
 * instantly, but the URL — and therefore the actual query — only updates
 * once typing pauses, so a request isn't fired per character.
 */
export function useRunFilters() {
  const [status, setStatus] = useSearchParamsState('status', 'all');
  const [urlProject, setUrlProject] = useSearchParamsState('project', '');
  const [project, setProjectInput] = useState(urlProject);

  useEffect(() => {
    const timer = setTimeout(() => setUrlProject(project), PROJECT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setUrlProject is stable; only `project` should re-arm the timer.
  }, [project]);

  return {
    status: status as RunStatusFilter,
    setStatus: (v: RunStatusFilter) => setStatus(v),
    project,
    setProject: setProjectInput,
  };
}
