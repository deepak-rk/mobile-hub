// Imported across features on purpose: the project list is served by
// `/api/execution/projects`, so this is where it genuinely lives. Duplicating
// the query here would be how the two screens drift back apart.
import { useProjects } from '../../execution/api/execution.api';
import styles from './AnalyticsFilterBar.module.css';

export type AnalyticsPlatformFilter = 'all' | 'android' | 'ios';
export type AnalyticsWindow = 'daily' | 'weekly';

const PLATFORM_OPTIONS: { value: AnalyticsPlatformFilter; label: string }[] = [
  { value: 'all', label: 'All platforms' },
  { value: 'android', label: 'Android' },
  { value: 'ios', label: 'iOS' },
];

const WINDOW_OPTIONS: { value: AnalyticsWindow; label: string }[] = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
];

export function AnalyticsFilterBar({
  project,
  onProjectChange,
  platform,
  onPlatformChange,
  window,
  onWindowChange,
}: {
  project: string;
  onProjectChange: (v: string) => void;
  platform: AnalyticsPlatformFilter;
  onPlatformChange: (v: AnalyticsPlatformFilter) => void;
  window: AnalyticsWindow;
  onWindowChange: (v: AnalyticsWindow) => void;
}) {
  const { data: projects } = useProjects();

  // A project filtered to in the URL that the list doesn't know about — a run
  // whose project was since removed from config, or a hand-edited link. Kept as
  // an option so the select can show what is actually being filtered rather
  // than silently snapping back to "All projects" and showing different data
  // than the URL says.
  const options = projects ?? [];
  const unknownSelection = project !== '' && !options.some((p) => p.id === project);

  return (
    <div className={styles.bar}>
      <label className={styles.field}>
        <span className={styles.label}>Project</span>
        <select
          className={styles.select}
          value={project}
          onChange={(e) => onProjectChange(e.target.value)}
        >
          <option value="">All projects</option>
          {options.map((p) => (
            <option key={p.id} value={p.id}>
              {p.displayName}
            </option>
          ))}
          {unknownSelection ? <option value={project}>{project} (not configured)</option> : null}
        </select>
      </label>

      <label className={styles.field}>
        <span className={styles.label}>Window</span>
        <select
          className={styles.select}
          value={window}
          onChange={(e) => onWindowChange(e.target.value as AnalyticsWindow)}
        >
          {WINDOW_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>

      <label className={styles.field}>
        <span className={styles.label}>Platform</span>
        <select
          className={styles.select}
          value={platform}
          onChange={(e) => onPlatformChange(e.target.value as AnalyticsPlatformFilter)}
        >
          {PLATFORM_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>

      {project !== '' || platform !== 'all' || window !== 'daily' ? (
        <button
          type="button"
          className={styles.clear}
          onClick={() => {
            onProjectChange('');
            onPlatformChange('all');
            onWindowChange('daily');
          }}
        >
          Clear filters
        </button>
      ) : null}
    </div>
  );
}
