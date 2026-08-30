export interface DeviceLock {
  heldBy: string;
  sessionId: string;
  acquiredAt: string;
  reason?: string;
}

export interface Device {
  _id: string;
  udid: string;
  machineId: string;
  platform: 'android' | 'ios';
  name: string;
  osVersion: string;
  model: string;
  connectionType: 'usb' | 'network' | 'simulator' | 'emulator';
  status: 'idle' | 'smoke' | 'in-use' | 'offline' | 'unreachable';
  lock: DeviceLock | null;
  isLocallyReachable: boolean;
  lastSeenAt: string;
  /**
   * An install is in flight on this device right now.
   *
   * Derived server-side per request, not stored: installs deliberately take no
   * device lock, so `status` stays `idle` throughout one. Without this flag a
   * device being actively reinstalled looked free to grab.
   */
  activeInstall?: boolean;
}
