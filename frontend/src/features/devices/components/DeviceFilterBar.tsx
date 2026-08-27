import type { Device } from '../types';
import styles from './DeviceFilterBar.module.css';

export type DeviceStatusFilter = Device['status'] | 'all';
export type DevicePlatformFilter = Device['platform'] | 'all';

const STATUS_OPTIONS: { value: DeviceStatusFilter; label: string }[] = [
  { value: 'all', label: 'All statuses' },
  { value: 'idle', label: 'Idle' },
  { value: 'smoke', label: 'Smoke' },
  { value: 'in-use', label: 'In use' },
  { value: 'offline', label: 'Offline' },
  { value: 'unreachable', label: 'Unreachable' },
];

const PLATFORM_OPTIONS: { value: DevicePlatformFilter; label: string }[] = [
  { value: 'all', label: 'All platforms' },
  { value: 'android', label: 'Android' },
  { value: 'ios', label: 'iOS' },
];

export function DeviceFilterBar({
  status,
  onStatusChange,
  platform,
  onPlatformChange,
}: {
  status: DeviceStatusFilter;
  onStatusChange: (v: DeviceStatusFilter) => void;
  platform: DevicePlatformFilter;
  onPlatformChange: (v: DevicePlatformFilter) => void;
}) {
  return (
    <div className={styles.bar}>
      <label className={styles.field}>
        <span className={styles.label}>Status</span>
        <select
          className={styles.select}
          value={status}
          onChange={(e) => onStatusChange(e.target.value as DeviceStatusFilter)}
        >
          {STATUS_OPTIONS.map((o) => (
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
          onChange={(e) => onPlatformChange(e.target.value as DevicePlatformFilter)}
        >
          {PLATFORM_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>

      {status !== 'all' || platform !== 'all' ? (
        <button
          type="button"
          className={styles.clear}
          onClick={() => {
            onStatusChange('all');
            onPlatformChange('all');
          }}
        >
          Clear filters
        </button>
      ) : null}
    </div>
  );
}
