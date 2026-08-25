/** A device as the hub's POST /api/devices/sync expects it. */
export interface DiscoveredDevice {
  udid: string;
  platform: 'android' | 'ios';
  name: string;
  osVersion: string;
  model: string;
  connectionType: 'usb' | 'network' | 'simulator' | 'emulator';
}

/**
 * One adapter per way of finding devices on a host — adb today, `xcrun simctl`
 * and WebDriverAgent later. Same shape as CaptureSource and BuildProvider:
 * adding a platform means writing an adapter, not editing the agent loop.
 */
export interface DeviceDiscovery {
  readonly name: string;
  /** Whether this host can run this discovery at all (e.g. is adb installed?). */
  isAvailable(): Promise<boolean>;
  discover(): Promise<DiscoveredDevice[]>;
}
