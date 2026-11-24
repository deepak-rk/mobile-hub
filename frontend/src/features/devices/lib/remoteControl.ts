import type { DeviceAction, DeviceJob } from '../api/devices.api';
import type { Device } from '../types';

/**
 * Where a point on the stream image falls on the phone's screen, as fractions
 * (0–1) of the screen, or null when it falls outside the picture. The image is
 * drawn with `object-fit: contain`, so its box can be larger than the picture
 * (letterboxing); the picture's own rectangle is worked out from its natural
 * size, which is what makes a click land where it looks like it lands.
 */
export function pointToScreenFraction(
  clientX: number,
  clientY: number,
  box: { left: number; top: number; width: number; height: number },
  naturalWidth: number,
  naturalHeight: number,
): { x: number; y: number } | null {
  if (!naturalWidth || !naturalHeight || !box.width || !box.height) return null;
  const scale = Math.min(box.width / naturalWidth, box.height / naturalHeight);
  const w = naturalWidth * scale;
  const h = naturalHeight * scale;
  const left = box.left + (box.width - w) / 2;
  const top = box.top + (box.height - h) / 2;
  const x = (clientX - left) / w;
  const y = (clientY - top) / h;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y };
}

/** Below this distance (fraction of the screen) a press counts as a tap, not a swipe. */
export const TAP_SLOP = 0.02;

/**
 * Who may control a phone: the person holding it, on Android, while no test
 * run holds it. The hub enforces the same rule; this only decides whether to
 * offer the controls at all.
 */
export function canControl(device: Device, userId: string | undefined): boolean {
  return (
    Boolean(userId) &&
    device.platform === 'android' &&
    device.status !== 'offline' &&
    device.status !== 'unreachable' &&
    device.lock?.heldBy === userId &&
    !device.lock?.reason?.startsWith('execution:')
  );
}

export const KEYS: { key: Extract<DeviceAction, { kind: 'key' }>['key']; label: string }[] = [
  { key: 'back', label: 'Back' },
  { key: 'home', label: 'Home' },
  { key: 'app_switch', label: 'Recent apps' },
  { key: 'volume_down', label: 'Volume down' },
  { key: 'volume_up', label: 'Volume up' },
  { key: 'power', label: 'Power' },
];

const FAILED: Record<string, string> = {
  failed: 'Failed',
  timed_out: 'Timed out',
  interrupted: 'Interrupted',
};

/** A short name for an action, for the status line. Never the typed text. */
export function labelOf(action: DeviceAction | undefined): string {
  if (!action) return '';
  switch (action.kind) {
    case 'key':
      return KEYS.find((k) => k.key === action.key)?.label ?? action.key;
    case 'rotate':
      return action.rotation % 2 === 0 ? 'Portrait' : 'Landscape';
    case 'tap':
      return 'Tap';
    case 'swipe':
      return 'Swipe';
    case 'text':
      return 'Type';
    case 'reboot':
      return 'Reboot';
  }
}

/** One line on how the last action went, from the hub's record of it. */
export function lastResultText(label: string, job: DeviceJob): string {
  if (job.status === 'succeeded') return `${label}: done${job.output ? ` (${job.output})` : ''}`;
  if (job.status === 'queued' || job.status === 'running') return `${label}: still waiting for the phone`;
  return `${label}: ${FAILED[job.status] ?? job.status}${job.error ? ` — ${job.error}` : ''}`;
}
