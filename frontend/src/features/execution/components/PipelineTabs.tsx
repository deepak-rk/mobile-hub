import type { PipelineTab } from '../hooks/usePipelineTab';
import styles from './PipelineTabs.module.css';

interface PipelineTabsProps {
  active: PipelineTab;
  onChange: (tab: PipelineTab) => void;
  currentCount: number;
  historyCount: number;
}

/**
 * A plain button-group, not an ARIA tabs widget — matches the shape the
 * project's other URL-synced filters already use (`useDeviceFilters`,
 * `useRunFilters`) rather than inventing a new pattern, and there's no
 * `Tabs` primitive in `react-design-kit` yet to build on
 * (docs/ui-guidelines.md §9 lists it as still-to-build).
 */
export function PipelineTabs({ active, onChange, currentCount, historyCount }: PipelineTabsProps) {
  return (
    <div className={styles.group} role="group" aria-label="Execution view">
      <button
        type="button"
        className={`${styles.tab} ${active === 'trigger' ? styles.active : ''}`}
        aria-pressed={active === 'trigger'}
        onClick={() => onChange('trigger')}
      >
        Trigger
      </button>
      <button
        type="button"
        className={`${styles.tab} ${active === 'current' ? styles.active : ''}`}
        aria-pressed={active === 'current'}
        onClick={() => onChange('current')}
      >
        Current ({currentCount})
      </button>
      <button
        type="button"
        className={`${styles.tab} ${active === 'history' ? styles.active : ''}`}
        aria-pressed={active === 'history'}
        onClick={() => onChange('history')}
      >
        History ({historyCount})
      </button>
    </div>
  );
}
