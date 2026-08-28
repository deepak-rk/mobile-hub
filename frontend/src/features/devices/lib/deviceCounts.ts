import type { Device } from '../types';

export function countBy(devices: Device[] | undefined, status: Device['status']): number {
  return devices?.filter((d) => d.status === status).length ?? 0;
}

/** A device is "offline" for grouping/collapse purposes if it's unreachable either way — the two statuses read the same to an operator. */
export function isOfflineStatus(status: Device['status']): boolean {
  return status === 'offline' || status === 'unreachable';
}

export function countOnline(devices: Device[] | undefined): number {
  return devices?.filter((d) => !isOfflineStatus(d.status)).length ?? 0;
}
