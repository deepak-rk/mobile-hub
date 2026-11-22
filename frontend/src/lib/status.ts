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
  | 'purged'
  // device install target
  | 'transferring'
  | 'installing'
  | 'granting-permissions'
  | 'done'
  | 'done-warning'
  | 'error'
  // host
  | 'online'
  // agent credential
  | 'active'
  | 'revoked';

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
  // GC'd by the retention sweep (builds-gc.test.ts) — the record stays for
  // audit trail, but the file's gone, so it reads distinctly from a live
  // failure state (corrupt) rather than sharing its red.
  purged: { label: 'Purged', token: '--status-cancelled', icon: icons.remove },

  // Agent credentials
  active: { label: 'Active', token: '--status-passed', icon: icons.credential },
  revoked: { label: 'Revoked', token: '--status-cancelled', icon: icons.offline },

  // Device install targets
  // Copying the artifact onto the device — measured in real bytes, unlike
  // `installing` (dexopt), which is why they are separate statuses.
  transferring: { label: 'Copying to device', token: '--status-running', icon: icons.downloading, active: true },
  installing: { label: 'Installing', token: '--status-running', icon: icons.running, active: true },
  // Org opt-in, off by default (`devices.grantPermissionsOnInstall`) — a
  // distinct stage rather than folded into `installing`, so it's visible
  // that this install did more than a plain `pm install -r`.
  'granting-permissions': { label: 'Granting permissions', token: '--status-running', icon: icons.running, active: true },
  done: { label: 'Done', token: '--status-passed', icon: icons.passed },
  // Not an API status: a `done` target that carries a note in `error` (the
  // install could not be verified, or runtime permissions were not granted).
  // Use `installTargetBadgeStatus` rather than spelling this out at call sites.
  'done-warning': { label: 'Done with warning', token: '--status-smoke', icon: icons.warning },
  error: { label: 'Error', token: '--status-failed', icon: icons.failed },
};

/**
 * The badge status for an install target. The agent reports a non-fatal note
 * on a `done` target through its `error` field (there is no separate warning
 * field on the report contract), so `done` + a note is success-with-warning,
 * not plain success.
 */
export function installTargetBadgeStatus(target: { status: string; error?: string | null }): string {
  return target.status === 'done' && target.error ? 'done-warning' : target.status;
}

export function getStatusMeta(status: string): StatusMeta {
  return (
    statusMeta[status as StatusKind] ?? {
      label: status,
      token: '--status-cancelled',
      icon: icons.dot,
    }
  );
}
