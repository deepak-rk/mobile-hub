import { Field } from 'react-design-kit';
import type { RunStatus } from '../types';
import styles from './RunFilterBar.module.css';

export type RunStatusFilter = RunStatus | 'all';

const STATUS_OPTIONS: { value: RunStatusFilter; label: string }[] = [
  { value: 'all', label: 'All statuses' },
  { value: 'queued', label: 'Queued' },
  { value: 'preparing', label: 'Preparing' },
  { value: 'running', label: 'Running' },
  { value: 'passed', label: 'Passed' },
  { value: 'failed', label: 'Failed' },
  { value: 'cancelled', label: 'Cancelled' },
];

export function RunFilterBar({
  status,
  onStatusChange,
  project,
  onProjectChange,
}: {
  status: RunStatusFilter;
  onStatusChange: (v: RunStatusFilter) => void;
  project: string;
  onProjectChange: (v: string) => void;
}) {
  return (
    <div className={styles.bar}>
      <label className={styles.field}>
        <span className={styles.label}>Status</span>
        <select
          className={styles.select}
          value={status}
          onChange={(e) => onStatusChange(e.target.value as RunStatusFilter)}
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>

      <div className={styles.field}>
        <Field
          label="Project"
          placeholder="Filter by project…"
          value={project}
          onChange={(e) => onProjectChange(e.target.value)}
        />
      </div>

      {status !== 'all' || project !== '' ? (
        <button
          type="button"
          className={styles.clear}
          onClick={() => {
            onStatusChange('all');
            onProjectChange('');
          }}
        >
          Clear filters
        </button>
      ) : null}
    </div>
  );
}
