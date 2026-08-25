import { DeviceDiscovery, DiscoveredDevice } from '../device-discovery';

const FIXTURES: DiscoveredDevice[] = [
  {
    udid: 'synthetic-pixel-7',
    platform: 'android',
    name: 'Pixel 7',
    osVersion: '14',
    model: 'Pixel 7',
    connectionType: 'usb',
  },
  {
    udid: 'synthetic-galaxy-s23',
    platform: 'android',
    name: 'Galaxy S23',
    osVersion: '14',
    model: 'SM-S911B',
    connectionType: 'usb',
  },
  {
    udid: 'emulator-5554',
    platform: 'android',
    name: 'Pixel 7 Emulator',
    osVersion: '14',
    model: 'sdk_gphone64_x86_64',
    connectionType: 'emulator',
  },
];

/**
 * Reports a fixed set of devices instead of probing the host.
 *
 * Lets the agent, and everything downstream of it, be exercised on a machine
 * with no devices attached — the same reason the synthetic capture source
 * exists. Opt-in via AGENT_DISCOVERY=synthetic only, so a real deployment
 * whose adb is broken fails visibly instead of quietly serving fake devices.
 */
export class SyntheticDeviceDiscovery implements DeviceDiscovery {
  readonly name = 'synthetic';

  constructor(private readonly devices: DiscoveredDevice[] = FIXTURES) {}

  isAvailable(): Promise<boolean> {
    return Promise.resolve(true);
  }

  discover(): Promise<DiscoveredDevice[]> {
    return Promise.resolve(this.devices);
  }
}
