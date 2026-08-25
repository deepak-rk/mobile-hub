import { icons } from './icons';

/**
 * Every status the API can return, mapped to its token, icon and human label.
 * Guidelines §7: status is never color-only — each entry carries an icon and
 * text so the meaning survives colorblindness, greyscale, and screen readers.
 */
export type StatusKind =
  // device
  | 'idle'
  | 'smoke'
  | 'in-use'
  | 'offline'
  | 'unreachable'
  // execution run
  | 'queued'
  | 'preparing'
  | 'running'
  | 'passed'
  | 'failed'
  | 'cancelled'
  // build
  | 'downloading'
  | 'validating'
  | 'corrupt'
  | 'ready'
  // host
  | 'online';

interface StatusMeta {
  label: string;
  /** CSS custom property holding this status's color. */
  token: string;
  icon: (typeof icons)[keyof typeof icons];
  /** Continuous activity — drives the subtle pulse on the indicator. */
  active?: boolean;
}

export const statusMeta: Record<StatusKind, StatusMeta> = {
  // Devices
  idle: { label: 'Idle', token: '--status-idle', icon: icons.dot },
  smoke: { label: 'Smoke', token: '--status-smoke', icon: icons.dot },
  'in-use': { label: 'In use', token: '--status-in-use', icon: icons.locked },
  offline: { label: 'Offline', token: '--status-offline', icon: icons.offline },
  unreachable: { label: 'Unreachable', token: '--status-offline', icon: icons.offline },

  // Hosts
  online: { label: 'Online', token: '--status-idle', icon: icons.dot },

  // Execution runs
  queued: { label: 'Queued', token: '--status-cancelled', icon: icons.dot },
  preparing: { label: 'Preparing', token: '--status-running', icon: icons.running, active: true },
  running: { label: 'Running', token: '--status-running', icon: icons.running, active: true },
  passed: { label: 'Passed', token: '--status-passed', icon: icons.passed },
  failed: { label: 'Failed', token: '--status-failed', icon: icons.failed },
  cancelled: { label: 'Cancelled', token: '--status-cancelled', icon: icons.cancelled },

  // Builds
  downloading: { label: 'Downloading', token: '--status-running', icon: icons.downloading, active: true },
  validating: { label: 'Validating', token: '--status-smoke', icon: icons.validating, active: true },
  corrupt: { label: 'Corrupt', token: '--status-failed', icon: icons.corrupt },
  ready: { label: 'Ready', token: '--status-passed', icon: icons.ready },
};

export function getStatusMeta(status: string): StatusMeta {
  return (
    statusMeta[status as StatusKind] ?? {
      label: status,
      token: '--status-cancelled',
      icon: icons.dot,
    }
  );
}
