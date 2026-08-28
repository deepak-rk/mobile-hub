import { Field } from 'react-design-kit';
import styles from './RunFilterBar.module.css';

/**
 * Project is the only filter left here — status is now expressed by the
 * pipeline page's Current/History tabs (see `usePipelineTab`), not a
 * dropdown alongside this one.
 */
export function RunFilterBar({
  project,
  onProjectChange,
}: {
  project: string;
  onProjectChange: (v: string) => void;
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

      {project !== '' ? (
        <button type="button" className={styles.clear} onClick={() => onProjectChange('')}>
          Clear filter
        </button>
      ) : null}
    </div>
  );
}
