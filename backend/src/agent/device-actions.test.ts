import { describe, it, expect } from 'vitest';
import { deviceActionSchema } from '../common/device-actions';
import { parseCurrentRotation, parseCurrentSize, quoteForInputText, runDeviceAction } from './device-actions';

/** Records every adb call; answers `dumpsys window displays` from `displays` in turn. */
function fakeAdb(displays: string[] = []) {
  const calls: string[] = [];
  let i = 0;
  const runFn = (_cmd: string, args: string[]) => {
    calls.push(args.join(' '));
    const stdout = args.includes('dumpsys') ? (displays[Math.min(i++, displays.length - 1)] ?? '') : '';
    return Promise.resolve({ stdout, stderr: '' });
  };
  return { calls, deps: { runFn, adbPath: 'adb', sleep: () => Promise.resolve() } };
}

// Lines as `dumpsys window displays` printed them on an Android 14 emulator.
const PORTRAIT = '    init=1080x2220 440dpi cur=1080x2220 app=1080x2154\n      mCurrentRotation=ROTATION_0';
const LANDSCAPE = '    init=1080x2220 440dpi cur=2220x1080 app=2220x1080\n      mCurrentRotation=ROTATION_90';

describe('runDeviceAction', () => {
  it('presses a key by its Android key code', async () => {
    const adb = fakeAdb();
    expect(await runDeviceAction('d1', { kind: 'key', key: 'home' }, adb.deps)).toEqual({ status: 'succeeded' });
    expect(adb.calls).toEqual(['-s d1 shell input keyevent 3']);
  });

  it('maps a tap from screen fractions to pixels in the current orientation', async () => {
    const adb = fakeAdb([LANDSCAPE]);
    await runDeviceAction('d1', { kind: 'tap', x: 0.5, y: 1 }, adb.deps);
    expect(adb.calls[1]).toBe('-s d1 shell input tap 1110 1079');
  });

  it('fails a tap it cannot place rather than guessing a size', async () => {
    const adb = fakeAdb(['nothing useful']);
    expect(await runDeviceAction('d1', { kind: 'tap', x: 0.5, y: 0.5 }, adb.deps)).toMatchObject({ status: 'failed' });
    expect(adb.calls).toHaveLength(1);
  });

  it('confirms a rotation from the display, not from the setting', async () => {
    const adb = fakeAdb([PORTRAIT, LANDSCAPE]);
    expect(await runDeviceAction('d1', { kind: 'rotate', rotation: 1 }, adb.deps)).toMatchObject({
      status: 'succeeded',
      output: 'display at 90°',
    });
    expect(adb.calls.slice(0, 2)).toEqual([
      '-s d1 shell settings put system accelerometer_rotation 0',
      '-s d1 shell settings put system user_rotation 1',
    ]);
  });

  it('reports a rotation the display never showed as failed', async () => {
    const adb = fakeAdb([PORTRAIT]);
    const out = await runDeviceAction('d1', { kind: 'rotate', rotation: 1 }, adb.deps);
    expect(out.status).toBe('failed');
    expect(out.error).toContain('stayed at 0°');
  });

  it('reports adb failing as a failed action with its message', async () => {
    const runFn = () => Promise.reject(Object.assign(new Error('Command failed'), { stderr: "adb: device 'd1' not found\n" }));
    expect(await runDeviceAction('d1', { kind: 'reboot' }, { runFn })).toEqual({
      status: 'failed',
      error: "adb: device 'd1' not found",
    });
  });
});

describe('quoteForInputText', () => {
  it('single-quotes for the phone shell and spells spaces as %s', () => {
    expect(quoteForInputText("it's a b")).toBe(`'it'\\''s%sa%sb'`);
    expect(quoteForInputText('$(reboot);`x`')).toBe("'$(reboot);`x`'");
  });
});

describe('parsers', () => {
  it('read size and rotation from dumpsys', () => {
    expect(parseCurrentSize(LANDSCAPE)).toEqual({ width: 2220, height: 1080 });
    expect(parseCurrentRotation(LANDSCAPE)).toBe(1);
    expect(parseCurrentRotation('no rotation here')).toBeNull();
  });
});

describe('deviceActionSchema', () => {
  it('takes fractions, printable ASCII text and known keys only', () => {
    expect(deviceActionSchema.safeParse({ kind: 'tap', x: 1.2, y: 0 }).success).toBe(false);
    expect(deviceActionSchema.safeParse({ kind: 'text', text: 'line\nbreak' }).success).toBe(false);
    expect(deviceActionSchema.safeParse({ kind: 'text', text: 'café' }).success).toBe(false);
    expect(deviceActionSchema.safeParse({ kind: 'key', key: 'self_destruct' }).success).toBe(false);
    expect(deviceActionSchema.parse({ kind: 'swipe', x1: 0, y1: 0, x2: 1, y2: 1 })).toMatchObject({ durationMs: 300 });
  });
});
