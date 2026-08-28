import { countBy } from '../lib/deviceCounts';
import type { Device } from '../types';
import type { useDeviceFilters } from '../hooks/useDeviceFilters';
import styles from './FilterChips.module.css';

/**
 * Quick-filter chips bound to the same URL-synced state `DeviceFilterBar`
 * uses — not a second filter mechanism, just a faster, count-bearing way to
 * hit the same status/platform values the dropdowns already expose. Counts
 * come from the already-fetched (possibly already-filtered) `devices` list,
 * so a chip's number reflects the current view, not a separate global fetch.
 */
export function FilterChips({
  devices,
  status,
  setStatus,
  platform,
  setPlatform,
}: {
  devices: Device[];
  status: ReturnType<typeof useDeviceFilters>['status'];
  setStatus: ReturnType<typeof useDeviceFilters>['setStatus'];
  platform: ReturnType<typeof useDeviceFilters>['platform'];
  setPlatform: ReturnType<typeof useDeviceFilters>['setPlatform'];
}) {
  const chips = [
    {
      key: 'all',
      label: 'All',
      count: devices.length,
      active: status === 'all' && platform === 'all',
      onClick: () => {
        setStatus('all');
        setPlatform('all');
      },
    },
    {
      key: 'idle',
      label: 'Idle',
      count: countBy(devices, 'idle'),
      active: status === 'idle',
      onClick: () => setStatus(status === 'idle' ? 'all' : 'idle'),
    },
    {
      key: 'in-use',
      label: 'In use',
      count: countBy(devices, 'in-use'),
      active: status === 'in-use',
      onClick: () => setStatus(status === 'in-use' ? 'all' : 'in-use'),
    },
    {
      key: 'offline',
      label: 'Offline',
      count: countBy(devices, 'offline'),
      active: status === 'offline',
      onClick: () => setStatus(status === 'offline' ? 'all' : 'offline'),
    },
    {
      key: 'android',
      label: 'Android',
      count: devices.filter((d) => d.platform === 'android').length,
      active: platform === 'android',
      onClick: () => setPlatform(platform === 'android' ? 'all' : 'android'),
    },
    {
      key: 'ios',
      label: 'iOS',
      count: devices.filter((d) => d.platform === 'ios').length,
      active: platform === 'ios',
      onClick: () => setPlatform(platform === 'ios' ? 'all' : 'ios'),
    },
  ];

  return (
    <div className={styles.chipRow} role="group" aria-label="Quick filters">
      {chips.map((chip) => (
        <button
          key={chip.key}
          type="button"
          className={`${styles.chip} ${chip.active ? styles.chipActive : ''}`}
          onClick={chip.onClick}
          aria-pressed={chip.active}
        >
          {chip.label} <span className={styles.chipCount}>{chip.count}</span>
        </button>
      ))}
    </div>
  );
}
