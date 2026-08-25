import { DeviceDiscovery } from '../device-discovery';
import { AdbDeviceDiscovery } from './adb-discovery';
import { SyntheticDeviceDiscovery } from './synthetic-discovery';

export function getDeviceDiscovery(kind = process.env.AGENT_DISCOVERY): DeviceDiscovery {
  if (kind === 'synthetic') return new SyntheticDeviceDiscovery();
  return new AdbDeviceDiscovery();
}
