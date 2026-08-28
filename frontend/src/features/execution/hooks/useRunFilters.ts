import { useEffect, useState } from 'react';
import { useSearchParamsState } from 'react-design-kit';

const PROJECT_DEBOUNCE_MS = 300;

/**
 * URL-synced project filter, backed by the same `project` query param
 * `GET /api/execution` already accepts server-side — filtering happens on
 * the backend, matching the same pattern `useDeviceFilters` established.
 *
 * There is no `status` filter here anymore: the pipeline page's Trigger /
 * Current / History tabs (`usePipelineTab`) now partition runs by terminal
 * state, which was the old status dropdown's main job — keeping both would
 * mean two overlapping ways to ask the same question (e.g. selecting
 * "Passed" while on the Current tab would always show nothing).
 *
 * `project` is free text (there's no fixed list of project names to offer as
 * a dropdown), so it's debounced: the input reflects every keystroke
 * instantly, but the URL — and therefore the actual query — only updates
 * once typing pauses, so a request isn't fired per character.
 */
export function useRunFilters() {
  const [urlProject, setUrlProject] = useSearchParamsState('project', '');
  const [project, setProjectInput] = useState(urlProject);

  useEffect(() => {
    const timer = setTimeout(() => setUrlProject(project), PROJECT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setUrlProject is stable; only `project` should re-arm the timer.
  }, [project]);

  return {
    project,
    setProject: setProjectInput,
  };
}
