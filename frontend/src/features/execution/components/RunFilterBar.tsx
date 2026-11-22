import { Field, Mono } from 'react-design-kit';
import styles from './RunFilterBar.module.css';

/**
 * Project is the only typed filter here — status is now expressed by the
 * pipeline page's Current/History tabs (see `usePipelineTab`), not a
 * dropdown alongside this one. A device filter arrives only via a link (the
 * analytics device breakdowns), so it's shown read-only with its own clear,
 * rather than silently narrowing the list with nothing on screen to say so.
 */
export function RunFilterBar({
  project,
  onProjectChange,
  device,
  onClearDevice,
  suite,
  onClearSuite,
}: {
  project: string;
  onProjectChange: (v: string) => void;
  device: { udid: string; machineId: string } | null;
  onClearDevice: () => void;
  suite: string;
  onClearSuite: () => void;
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

      {device ? (
        <span className={styles.device}>
          Device <Mono>{device.udid}</Mono>
          {device.machineId ? <> · {device.machineId}</> : null}
          <button type="button" className={styles.clear} onClick={onClearDevice}>
            Clear device
          </button>
        </span>
      ) : null}

      {suite !== '' ? (
        <span className={styles.device}>
          Suite <Mono>{suite}</Mono>
          <button type="button" className={styles.clear} onClick={onClearSuite}>
            Clear suite
          </button>
        </span>
      ) : null}

      {project !== '' ? (
        <button type="button" className={styles.clear} onClick={() => onProjectChange('')}>
          Clear filter
        </button>
      ) : null}
    </div>
  );
}
