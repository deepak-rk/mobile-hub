import { execFile } from 'child_process';
import { promisify } from 'util';
import { DeviceDiscovery, DiscoveredDevice } from '../device-discovery';

const run = promisify(execFile);
const PROP_TIMEOUT_MS = 5000;

interface AdbLine {
  serial: string;
  state: string;
  props: Record<string, string>;
}

/**
 * Parses `adb devices -l` output.
 *
 * Exported for testing: this is the part that actually breaks, since adb's
 * output varies by version, transport and device state, and a device in a
 * state we mishandle would either vanish from the lab or appear as usable
 * when it isn't.
 */
export function parseAdbDevices(stdout: string): AdbLine[] {
  return stdout
    .split(/\r?\n/)
    .slice(1) // drop the "List of devices attached" header
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [serial, state, ...rest] = line.split(/\s+/);
      const props: Record<string, string> = {};
      for (const token of rest) {
        const idx = token.indexOf(':');
        if (idx > 0) props[token.slice(0, idx)] = token.slice(idx + 1);
      }
      return { serial, state, props };
    })
    .filter((d) => d.serial && d.state);
}

/**
 * `adb` reports several non-usable states. Only `device` means ready:
 *  - `offline`      — connected but not responding
 *  - `unauthorized` — the USB debugging prompt hasn't been accepted
 *  - `no`           — "no permissions" (udev rules missing on Linux)
 *  - `recovery` / `sideload` / `bootloader` — not usable for testing
 * Reporting any of these as available would hand a broken device to a run.
 */
export function isUsableState(state: string): boolean {
  return state === 'device';
}

export function connectionTypeFor(serial: string): DiscoveredDevice['connectionType'] {
  if (serial.startsWith('emulator-')) return 'emulator';
  // `adb connect host:port` produces a serial containing a colon.
  if (serial.includes(':')) return 'network';
  return 'usb';
}

export class AdbDeviceDiscovery implements DeviceDiscovery {
  readonly name = 'adb';

  constructor(private readonly adbPath = process.env.ADB_PATH ?? 'adb') {}

  async isAvailable(): Promise<boolean> {
    try {
      await run(this.adbPath, ['version'], { timeout: PROP_TIMEOUT_MS });
      return true;
    } catch {
      return false;
    }
  }

  async discover(): Promise<DiscoveredDevice[]> {
    const { stdout } = await run(this.adbPath, ['devices', '-l'], { timeout: PROP_TIMEOUT_MS });
    const usable = parseAdbDevices(stdout).filter((d) => isUsableState(d.state));

    // Properties need a round trip each; do them concurrently but tolerate
    // individual failures — one wedged device must not hide the whole lab.
    const devices = await Promise.all(
      usable.map(async (d): Promise<DiscoveredDevice | null> => {
        try {
          const [osVersion, model] = await Promise.all([
            this.getProp(d.serial, 'ro.build.version.release'),
            this.getProp(d.serial, 'ro.product.model'),
          ]);
          return {
            udid: d.serial,
            platform: 'android',
            // `-l` gives a device codename; the marketing model is friendlier.
            name: model || d.props.model?.replace(/_/g, ' ') || d.serial,
            osVersion: osVersion || 'unknown',
            model: model || d.props.model || 'unknown',
            connectionType: connectionTypeFor(d.serial),
          };
        } catch {
          return null;
        }
      }),
    );

    return devices.filter((d): d is DiscoveredDevice => d !== null);
  }

  private async getProp(serial: string, prop: string): Promise<string> {
    const { stdout } = await run(this.adbPath, ['-s', serial, 'shell', 'getprop', prop], {
      timeout: PROP_TIMEOUT_MS,
    });
    return stdout.trim();
  }
}
