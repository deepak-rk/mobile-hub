import { describe, it, expect } from 'vitest';
import { parseAdbDevices, isUsableState, connectionTypeFor } from './adb-discovery';

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
