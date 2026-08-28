import { icons, iconSize } from '@/lib/icons';
import { countBy, countOnline } from '../lib/deviceCounts';
import type { Device } from '../types';
import styles from './InventorySummary.module.css';

/**
 * A scan line above the grid: at-a-glance totals for the current view.
 * "Online" is broader than any single status — everything that isn't
 * offline/unreachable — so it's computed here rather than reusing a status
 * filter value. Deliberately reads whatever `devices` the page already
 * fetched (guidelines: no extra request just for a summary row).
 */
export function InventorySummary({ devices }: { devices: Device[] }) {
  const items: { key: string; label: string; value: number; icon: (typeof icons)[keyof typeof icons]; tone: string }[] = [
    { key: 'total', label: 'total', value: devices.length, icon: icons.device, tone: 'var(--text-tertiary)' },
    { key: 'online', label: 'online', value: countOnline(devices), icon: icons.dot, tone: 'var(--status-idle)' },
    { key: 'in-use', label: 'in use', value: countBy(devices, 'in-use'), icon: icons.locked, tone: 'var(--status-in-use)' },
    {
      key: 'offline',
      label: 'offline',
      value: countBy(devices, 'offline') + countBy(devices, 'unreachable'),
      icon: icons.offline,
      tone: 'var(--status-offline)',
    },
  ];

  return (
    <div className={styles.inventory} role="group" aria-label="Device inventory summary">
      {items.map((item) => (
        <span key={item.key} className={styles.inventoryItem}>
          <item.icon size={iconSize.dense} aria-hidden="true" style={{ color: item.tone }} />
          <span className={styles.inventoryValue}>{item.value}</span>
          <span className={styles.inventoryLabel}>{item.label}</span>
        </span>
      ))}
    </div>
  );
}
