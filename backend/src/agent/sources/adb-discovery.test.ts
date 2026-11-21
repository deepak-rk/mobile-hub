import { describe, it, expect } from 'vitest';
import {
  parseAdbDevices,
  isUsableState,
  connectionTypeFor,
  resolveDeviceName,
  AdbDeviceDiscovery,
  MISSING_GRACE_POLLS,
  type AdbExec,
} from './adb-discovery';

/**
 * adb's output varies by version, transport and device state. Getting this
 * wrong either hides a real device from the lab or hands a broken one to a
 * run, so the parsing is pinned here rather than trusted.
 */
describe('parseAdbDevices', () => {
  it('returns nothing when no devices are attached', () => {
    expect(parseAdbDevices('List of devices attached\n')).toEqual([]);
    expect(parseAdbDevices('List of devices attached\r\n\r\n')).toEqual([]);
  });

  it('parses a usb device with its property tokens', () => {
    const out = [
      'List of devices attached',
      'RZ8N70XABCD           device usb:1-2 product:dm3q model:SM_S911B device:dm3q transport_id:2',
    ].join('\n');

    expect(parseAdbDevices(out)).toEqual([
      {
        serial: 'RZ8N70XABCD',
        state: 'device',
        props: { usb: '1-2', product: 'dm3q', model: 'SM_S911B', device: 'dm3q', transport_id: '2' },
      },
    ]);
  });

  it('parses several devices including non-ready states', () => {
    const out = [
      'List of devices attached',
      'emulator-5554         device product:sdk_gphone64 model:sdk_gphone64 device:emu64x',
      'RZ8N70XABCD           unauthorized usb:1-2',
      '192.168.1.44:5555     offline',
    ].join('\n');

    const parsed = parseAdbDevices(out);
    expect(parsed.map((d) => [d.serial, d.state])).toEqual([
      ['emulator-5554', 'device'],
      ['RZ8N70XABCD', 'unauthorized'],
      ['192.168.1.44:5555', 'offline'],
    ]);
  });

  it('handles CRLF output from Windows adb', () => {
    const out = 'List of devices attached\r\nemulator-5554\tdevice product:x\r\n';
    expect(parseAdbDevices(out)).toHaveLength(1);
  });
});

describe('isUsableState', () => {
  it('accepts only a fully ready device', () => {
    expect(isUsableState('device')).toBe(true);
  });

  it('rejects every state that cannot actually run a test', () => {
    // Reporting any of these as available would hand a broken device to a run.
    for (const state of ['offline', 'unauthorized', 'no', 'recovery', 'sideload', 'bootloader']) {
      expect(isUsableState(state), state).toBe(false);
    }
  });
});

describe('resolveDeviceName', () => {
  it('prefers the AVD name over the generic stock model on an emulator, cropped to the device profile', () => {
    // Real bug: Google's stock system images report ro.product.model as
    // "sdk_gphone64_x86_64" for every device profile, hiding which AVD
    // ("Pixel 3a", "Pixel 6", ...) is actually running. The full AVD name
    // also carries API-level/arch noise ("_API_34_extension_level_7_x86_64")
    // that isn't part of the device's identity, so it's cropped off.
    expect(
      resolveDeviceName({
        avdName: 'Pixel_3a_API_34_extension_level_7_x86_64',
        model: 'sdk_gphone64_x86_64',
        propsModel: 'sdk_gphone64_x86_64',
        serial: 'emulator-5554',
      }),
    ).toBe('Pixel 3a');
  });

  it('crops a simpler AVD name the same way', () => {
    expect(
      resolveDeviceName({ avdName: 'Pixel_6_API_33', model: '', propsModel: undefined, serial: 'emulator-5554' }),
    ).toBe('Pixel 6');
  });

  it('falls back to the marketing model on real hardware, where there is no AVD name', () => {
    expect(
      resolveDeviceName({ avdName: '', model: 'SM_S911B', propsModel: 'SM_S911B', serial: 'RZ8N70XABCD' }),
    ).toBe('SM_S911B');
  });

  it('falls back to the -l device codename when getprop model failed', () => {
    expect(resolveDeviceName({ avdName: '', model: '', propsModel: 'dm3q', serial: 'RZ8N70XABCD' })).toBe('dm3q');
  });

  it('falls back to the serial when nothing else is available', () => {
    expect(resolveDeviceName({ avdName: '', model: '', propsModel: undefined, serial: 'RZ8N70XABCD' })).toBe(
      'RZ8N70XABCD',
    );
  });
});

describe('connectionTypeFor', () => {
  it('recognises emulators by their serial prefix', () => {
    expect(connectionTypeFor('emulator-5554')).toBe('emulator');
  });

  it('treats a host:port serial as a network device', () => {
    expect(connectionTypeFor('192.168.1.44:5555')).toBe('network');
  });

  it('defaults to usb', () => {
    expect(connectionTypeFor('RZ8N70XABCD')).toBe('usb');
  });
});

/**
 * Regression for a real lock-stealing bug (2026-11-21): a single failed
 * property probe dropped the device from the report, and the hub reads an
 * absent device as gone — marking it offline and releasing its lock, out from
 * under a run executing on it. Driven through the real class with a scripted
 * fake adb, since the bug lives in how polls relate to each other.
 */
describe('AdbDeviceDiscovery across polls', () => {
  type Script = { devices: string; failProps?: boolean; bootCompleted?: string };

  function fakeAdb(script: () => Script): AdbExec {
    return async (args) => {
      const s = script();
      if (args[0] === 'devices') return `List of devices attached\n${s.devices}\n`;
      if (args[0] === 'version') return 'Android Debug Bridge';
      const prop = args[args.length - 1];
      if (s.failProps) throw new Error('error: device offline');
      if (prop === 'sys.boot_completed') return s.bootCompleted ?? '1';
      if (prop === 'ro.build.version.release') return '14';
      if (prop === 'ro.product.model') return 'Pixel 7';
      return '';
    };
  }

  const LISTED = 'R58N123ABC device usb:1-1 product:x model:Pixel_7 device:y';

  it('keeps a still-listed device whose property probe failed, using its last good record', async () => {
    let script: Script = { devices: LISTED };
    const discovery = new AdbDeviceDiscovery('adb', fakeAdb(() => script));
    expect((await discovery.discover()).map((d) => d.udid)).toEqual(['R58N123ABC']);

    script = { devices: LISTED, failProps: true };
    expect((await discovery.discover()).map((d) => d.udid)).toEqual(['R58N123ABC']);
  });

  it('keeps a device that briefly disappears from adb for a grace period, then drops it', async () => {
    let script: Script = { devices: LISTED };
    const discovery = new AdbDeviceDiscovery('adb', fakeAdb(() => script));
    await discovery.discover();

    script = { devices: '' };
    for (let i = 0; i < MISSING_GRACE_POLLS; i++) {
      expect((await discovery.discover()).map((d) => d.udid)).toEqual(['R58N123ABC']);
    }
    expect(await discovery.discover()).toEqual([]);
  });

  it('does not report an emulator until Android has finished booting, then keeps it booted across blips', async () => {
    const EMU = 'emulator-5554 device product:sdk model:sdk_gphone64 device:emu';
    let script: Script = { devices: EMU, bootCompleted: '' };
    const discovery = new AdbDeviceDiscovery('adb', fakeAdb(() => script));
    expect(await discovery.discover()).toEqual([]); // listed as "device", but still booting

    script = { devices: EMU, bootCompleted: '1' };
    expect((await discovery.discover()).map((d) => d.udid)).toEqual(['emulator-5554']);

    // A later transient boot-prop read failure must not un-boot it.
    script = { devices: EMU, bootCompleted: '' };
    expect((await discovery.discover()).map((d) => d.udid)).toEqual(['emulator-5554']);
  });

  it('never invents a device it has never seen succeed', async () => {
    const discovery = new AdbDeviceDiscovery('adb', fakeAdb(() => ({ devices: LISTED, failProps: true })));
    expect(await discovery.discover()).toEqual([]);
  });
});
