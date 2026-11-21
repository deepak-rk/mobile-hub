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

/**
 * Picks the friendliest available device name. Google's stock emulator
 * system images report a generic `ro.product.model` ("sdk_gphone64_x86_64")
 * for every device profile — the actual AVD name (e.g. "Pixel_3a_API_34...")
 * only lives in `ro.boot.qemu.avd_name`, which real hardware never sets, so
 * it takes priority whenever present.
 *
 * The AVD name itself carries API-level/arch/extension-level suffixes
 * ("Pixel_3a_API_34_extension_level_7_x86_64") that make sense as a unique
 * AVD identifier but are noise as a *device* name — cropped at the first
 * "_API_" (present in every AVD Android Studio generates) so the display
 * name is just the device profile ("Pixel 3a").
 */
export function resolveDeviceName(params: {
  avdName: string;
  model: string;
  propsModel: string | undefined;
  serial: string;
}): string {
  const { avdName, model, propsModel, serial } = params;
  if (avdName) return avdName.split(/_API_/i)[0].replace(/_/g, ' ');
  if (model) return model;
  if (propsModel) return propsModel.replace(/_/g, ' ');
  return serial;
}

export function connectionTypeFor(serial: string): DiscoveredDevice['connectionType'] {
  if (serial.startsWith('emulator-')) return 'emulator';
  // `adb connect host:port` produces a serial containing a colon.
  if (serial.includes(':')) return 'network';
  return 'usb';
}

/** Runs one adb invocation and returns its stdout. Injectable so discovery can be tested without a device. */
export type AdbExec = (args: string[]) => Promise<string>;

/**
 * How many consecutive polls a device may be absent from `adb devices` before
 * it stops being reported. One transient blip is common (USB re-enumeration,
 * adb server restart); dropping a device on the first miss made the hub mark
 * it offline *and release its lock* — out from under a run executing on it.
 */
export const MISSING_GRACE_POLLS = 2;

export class AdbDeviceDiscovery implements DeviceDiscovery {
  readonly name = 'adb';

  // State carried between polls — the whole point of the fix below.
  private readonly lastGood = new Map<string, DiscoveredDevice>();
  private readonly booted = new Set<string>();
  private readonly missedPolls = new Map<string, number>();
  private readonly exec: AdbExec;

  constructor(
    private readonly adbPath = process.env.ADB_PATH ?? 'adb',
    exec?: AdbExec,
  ) {
    this.exec = exec ?? (async (args) => (await run(this.adbPath, args, { timeout: PROP_TIMEOUT_MS })).stdout);
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.exec(['version']);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * One poll's view of the lab — deliberately *not* just "what answered this
   * instant".
   *
   * The previous version dropped a device whenever its property probe failed,
   * and reported only what `adb devices` listed right now. The hub reads an
   * absent device as gone: it marks it offline and **releases its lock**. So a
   * single transient blip (a 5 s getprop timeout, a USB re-enumeration) freed
   * the lock of a run executing on that device and let another run take it.
   * A production device farm in this domain hit the same thing ("partial
   * device list from one failed probe → devices vanished") and settled on the
   * same three rules applied here:
   *  - a device whose probe fails but is still listed keeps its last good record;
   *  - a device missing from the list is kept for `MISSING_GRACE_POLLS` polls
   *    before it is dropped;
   *  - an emulator is reported only once `sys.boot_completed=1` — adb lists it
   *    as `device` well before Android has finished booting, and a run handed a
   *    half-booted emulator fails for reasons nothing on screen explains — and
   *    once booted it stays booted across blips.
   */
  async discover(): Promise<DiscoveredDevice[]> {
    const stdout = await this.exec(['devices', '-l']);
    const usable = parseAdbDevices(stdout).filter((d) => isUsableState(d.state));
    const listed = new Set(usable.map((d) => d.serial));

    // Properties need a round trip each; do them concurrently but tolerate
    // individual failures — one wedged device must not hide the whole lab.
    const probed = await Promise.all(
      usable.map(async (d): Promise<DiscoveredDevice | null> => {
        try {
          const connectionType = connectionTypeFor(d.serial);
          if (connectionType === 'emulator' && !this.booted.has(d.serial)) {
            if ((await this.getProp(d.serial, 'sys.boot_completed')) !== '1') return null; // still booting
            this.booted.add(d.serial);
          }
          const [osVersion, model, avdName] = await Promise.all([
            this.getProp(d.serial, 'ro.build.version.release'),
            this.getProp(d.serial, 'ro.product.model'),
            // Google's stock emulator system images report a generic
            // ro.product.model ("sdk_gphone64_x86_64") for every device
            // profile — the actual AVD name (e.g. "Pixel_3a_API_34...")
            // only lives in this boot-time prop, which real hardware never
            // sets. Emulator-only, so only worth asking on that transport.
            connectionType === 'emulator' ? this.getProp(d.serial, 'ro.boot.qemu.avd_name') : Promise.resolve(''),
          ]);
          const device: DiscoveredDevice = {
            udid: d.serial,
            platform: 'android',
            name: resolveDeviceName({ avdName, model, propsModel: d.props.model, serial: d.serial }),
            osVersion: osVersion || 'unknown',
            model: model || d.props.model || 'unknown',
            connectionType,
          };
          this.lastGood.set(d.serial, device);
          return device;
        } catch {
          // Still listed by adb, only the probe failed: keep reporting what we
          // last knew rather than making the device vanish.
          return this.lastGood.get(d.serial) ?? null;
        }
      }),
    );

    const devices = probed.filter((d): d is DiscoveredDevice => d !== null);
    for (const d of devices) this.missedPolls.delete(d.udid);

    // Known devices adb did not list this time: keep them through a short
    // grace period, then let them go.
    for (const [serial, device] of this.lastGood) {
      if (listed.has(serial)) continue;
      const missed = (this.missedPolls.get(serial) ?? 0) + 1;
      if (missed > MISSING_GRACE_POLLS) {
        this.lastGood.delete(serial);
        this.booted.delete(serial);
        this.missedPolls.delete(serial);
        continue;
      }
      this.missedPolls.set(serial, missed);
      devices.push(device);
    }

    return devices;
  }

  private async getProp(serial: string, prop: string): Promise<string> {
    return (await this.exec(['-s', serial, 'shell', 'getprop', prop])).trim();
  }
}
