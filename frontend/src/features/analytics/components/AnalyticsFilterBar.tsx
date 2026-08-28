import { Field } from 'react-design-kit';
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
  return (
    <div className={styles.bar}>
      <div className={styles.field}>
        <Field
          label="Project"
          placeholder="Filter by project…"
          value={project}
          onChange={(e) => onProjectChange(e.target.value)}
        />
      </div>

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
