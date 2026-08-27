import { Field } from 'react-design-kit';
import styles from './AnalyticsFilterBar.module.css';

export type AnalyticsPlatformFilter = 'all' | 'android' | 'ios';

const PLATFORM_OPTIONS: { value: AnalyticsPlatformFilter; label: string }[] = [
  { value: 'all', label: 'All platforms' },
  { value: 'android', label: 'Android' },
  { value: 'ios', label: 'iOS' },
];

export function AnalyticsFilterBar({
  project,
  onProjectChange,
  platform,
  onPlatformChange,
}: {
  project: string;
  onProjectChange: (v: string) => void;
  platform: AnalyticsPlatformFilter;
  onPlatformChange: (v: AnalyticsPlatformFilter) => void;
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

      {project !== '' || platform !== 'all' ? (
        <button
          type="button"
          className={styles.clear}
          onClick={() => {
            onProjectChange('');
            onPlatformChange('all');
          }}
        >
          Clear filters
        </button>
      ) : null}
    </div>
  );
}
