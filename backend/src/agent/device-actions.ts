import { execFile } from 'child_process';
import { promisify } from 'util';
import { ANDROID_KEYCODES, type DeviceAction } from '../common/device-actions';

const run = promisify(execFile);
type Runner = (command: string, args: string[], options: { timeout: number }) => Promise<{ stdout: string; stderr: string }>;

const SHELL_TIMEOUT_MS = 10_000;
const REBOOT_TIMEOUT_MS = 30_000;
/** How long a rotation may take to show on the display before it counts as not applied. */
const ROTATE_SETTLE_MS = 6_000;
const ROTATE_POLL_MS = 500;

export interface ActionOutcome {
  status: 'succeeded' | 'failed';
  output?: string;
  error?: string;
}

export interface ActionDeps {
  runFn?: Runner;
  adbPath?: string;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Quotes text for the phone's shell. `adb shell` joins its arguments into one
 * command line, so the text is single-quoted (a `'` inside becomes `'\''`),
 * and spaces become `%s`, which is how `input text` spells a space.
 */
export function quoteForInputText(text: string): string {
  return `'${text.replace(/ /g, '%s').replace(/'/g, `'\\''`)}'`;
}

/** `cur=1080x2220` in `dumpsys window displays`: the size in the current orientation. */
export function parseCurrentSize(dumpsys: string): { width: number; height: number } | null {
  const m = /cur=(\d+)x(\d+)/.exec(dumpsys);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

/** `mCurrentRotation=ROTATION_90` → 1. */
export function parseCurrentRotation(dumpsys: string): number | null {
  const m = /mCurrentRotation=ROTATION_(0|90|180|270)\b/.exec(dumpsys);
  return m ? Number(m[1]) / 90 : null;
}

/**
 * Runs one action on an Android phone with adb. Each outcome is what the
 * phone showed, not what was asked: a rotation is read back from the display
 * itself (the setting reads back as changed even when the app on screen
 * holds its orientation and nothing turned).
 */
export async function runDeviceAction(udid: string, action: DeviceAction, deps: ActionDeps = {}): Promise<ActionOutcome> {
  const runFn = deps.runFn ?? run;
  const adb = deps.adbPath ?? process.env.ADB_PATH ?? 'adb';
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const shell = async (...args: string[]): Promise<string> =>
    (await runFn(adb, ['-s', udid, 'shell', ...args], { timeout: SHELL_TIMEOUT_MS })).stdout;
  const displays = (): Promise<string> => shell('dumpsys', 'window', 'displays');

  try {
    switch (action.kind) {
      case 'key':
        await shell('input', 'keyevent', String(ANDROID_KEYCODES[action.key]));
        return { status: 'succeeded' };
      case 'tap':
      case 'swipe': {
        const size = parseCurrentSize(await displays());
        if (!size) return { status: 'failed', error: "Could not read the phone's screen size." };
        const px = (f: number, extent: number): string => String(Math.round(f * (extent - 1)));
        if (action.kind === 'tap') {
          await shell('input', 'tap', px(action.x, size.width), px(action.y, size.height));
        } else {
          await shell(
            'input',
            'swipe',
            px(action.x1, size.width),
            px(action.y1, size.height),
            px(action.x2, size.width),
            px(action.y2, size.height),
            String(action.durationMs),
          );
        }
        return { status: 'succeeded', output: `screen ${size.width}x${size.height}` };
      }
      case 'text':
        await shell('input', 'text', quoteForInputText(action.text));
        return { status: 'succeeded' };
      case 'rotate': {
        await shell('settings', 'put', 'system', 'accelerometer_rotation', '0');
        await shell('settings', 'put', 'system', 'user_rotation', String(action.rotation));
        let seen: number | null = null;
        for (let waited = 0; waited <= ROTATE_SETTLE_MS; waited += ROTATE_POLL_MS) {
          seen = parseCurrentRotation(await displays());
          if (seen === action.rotation) return { status: 'succeeded', output: `display at ${seen * 90}°` };
          await sleep(ROTATE_POLL_MS);
        }
        return {
          status: 'failed',
          error:
            seen === null
              ? "Rotation was set, but the display's rotation could not be read back to confirm it."
              : `The display stayed at ${seen * 90}°. The app on screen may fix its own orientation.`,
        };
      }
      case 'reboot':
        await runFn(adb, ['-s', udid, 'reboot'], { timeout: REBOOT_TIMEOUT_MS });
        return { status: 'succeeded', output: 'reboot started; the phone reconnects in a minute or two' };
    }
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    return { status: 'failed', error: (e.stderr?.trim() || e.message || String(err)).slice(0, 500) };
  }
}
