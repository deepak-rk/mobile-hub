import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { buildRunEnvironment, createRedactor, resolveAndroidSdkRoot } from './run-environment';

/**
 * The security-critical half of running someone else's test suite. The child
 * must not inherit the hub's environment: this workspace has already seen a
 * child dump its whole inherited environment into a crash report, so
 * "our code never prints the secret" is not a sufficient defence.
 */
afterEach(() => {
  delete process.env.MH_FAKE_SECRET;
});

describe('buildRunEnvironment', () => {
  it('does not pass through an arbitrary parent variable', () => {
    process.env.MH_FAKE_SECRET = 'super-secret-token';
    const env = buildRunEnvironment({ configured: {} });
    expect(env.MH_FAKE_SECRET).toBeUndefined();
  });

  it('passes through only what a process needs to run at all', () => {
    const env = buildRunEnvironment({ configured: {} });
    // PATH has to survive or nothing can resolve a binary.
    expect(env.PATH ?? env.Path).toBeDefined();
  });

  it('exposes the Appium endpoint and device under the names a suite expects', () => {
    const env = buildRunEnvironment({
      configured: {},
      appium: { host: '127.0.0.1', port: 4723, baseUrl: 'http://127.0.0.1:4723' },
      device: { udid: 'emulator-5554', name: 'Pixel 3a', platform: 'android', osVersion: '14' },
    });
    expect(env.APPIUM_BASE_URL).toBe('http://127.0.0.1:4723');
    expect(env.APPIUM_PORT).toBe('4723');
    expect(env.DEVICE_UDID).toBe('emulator-5554');
    expect(env.PLATFORM_VERSION).toBe('14');
  });

  /**
   * Reversed 2026-11-21. Configured env is org/project-wide; these are per-run
   * facts. A configured APPIUM_HOST/DEVICE_UDID pinned every run to one host
   * or device — the same bug a production farm hit when a test repo's
   * hardcoded remote host survived because the hub only wrote when missing.
   */
  it('never lets configured values override the per-run device and Appium coordinates', () => {
    const env = buildRunEnvironment({
      configured: { APPIUM_BASE_URL: 'https://grid.example.com', DEVICE_UDID: 'pinned-device', APP_ENV: 'staging' },
      appium: { host: '127.0.0.1', port: 4723, baseUrl: 'http://127.0.0.1:4723', path: '' },
      device: { udid: 'emulator-5554', platform: 'android', osVersion: '14', name: 'Pixel' },
    });
    expect(env.APPIUM_BASE_URL).toBe('http://127.0.0.1:4723');
    expect(env.DEVICE_UDID).toBe('emulator-5554');
    // Everything that isn't a per-run fact still comes through.
    expect(env.APP_ENV).toBe('staging');
  });

  it('hands the runner the base path, so a legacy /wd/hub server is not dialled at its bare origin', () => {
    const env = buildRunEnvironment({
      configured: {},
      appium: { host: '10.0.0.5', port: 4723, baseUrl: 'http://10.0.0.5:4723', path: '/wd/hub' },
    });
    expect(env.APPIUM_PATH).toBe('/wd/hub');
    expect(env.APPIUM_BASE_URL).toBe('http://10.0.0.5:4723/wd/hub');
  });

  it('uses "/" as the path for a server on the default base path', () => {
    const env = buildRunEnvironment({
      configured: {},
      appium: { host: 'h', port: 1, baseUrl: 'http://h:1', path: '' },
    });
    expect(env.APPIUM_PATH).toBe('/');
    expect(env.APPIUM_BASE_URL).toBe('http://h:1');
  });

  it('derives the driver from the platform and passes the run id', () => {
    const env = buildRunEnvironment({
      configured: {},
      device: { udid: 'u', platform: 'ios', osVersion: '17', name: 'n' },
      runId: 'run-42',
    });
    expect(env.AUTOMATION_NAME).toBe('XCUITest');
    expect(env.RUN_ID).toBe('run-42');
  });
});

describe('createRedactor', () => {
  it('masks a configured secret wherever it appears', () => {
    const redact = createRedactor({ API_KEY: 'sk-live-abcdef123456' });
    // Secrets leak by being printed, not by being named — the key name never
    // appears here, only the value.
    expect(redact('calling https://api/x?token=sk-live-abcdef123456 now')).toBe('calling https://api/x?token=*** now');
  });

  it('leaves short values alone', () => {
    // "true"/"1"/"dev" appear everywhere and are not credentials; masking them
    // would turn ordinary output into a wall of asterisks.
    const redact = createRedactor({ DEBUG: 'true', ENV: 'dev' });
    expect(redact('DEBUG is true in dev')).toBe('DEBUG is true in dev');
  });

  it('masks a longer secret fully even when a shorter one is a prefix of it', () => {
    // Replacing the short one first would leave the longer secret's tail
    // visible next to the mask.
    const redact = createRedactor({ SHORT: 'secret1234', LONG: 'secret1234567890' });
    expect(redact('value=secret1234567890')).toBe('value=***');
  });

  it('is a pass-through when nothing is configured', () => {
    expect(createRedactor({})('anything at all')).toBe('anything at all');
  });
});

describe('resolveAndroidSdkRoot', () => {
  // A declared root wins, so these tests must not see the machine's own:
  // CI runner images export ANDROID_HOME, which made every derivation case
  // below fail there while passing on a dev box that has none set.
  const saved = { home: process.env.ANDROID_HOME, root: process.env.ANDROID_SDK_ROOT };
  beforeEach(() => {
    delete process.env.ANDROID_HOME;
    delete process.env.ANDROID_SDK_ROOT;
  });
  afterEach(() => {
    for (const [key, value] of [['ANDROID_HOME', saved.home], ['ANDROID_SDK_ROOT', saved.root]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('prefers a declared ANDROID_HOME over deriving one', () => {
    process.env.ANDROID_HOME = '/opt/android-sdk';
    expect(resolveAndroidSdkRoot('C:/Users/x/AppData/Local/Android/Sdk/platform-tools/adb.exe')).toBe('/opt/android-sdk');
  });

  // Appium's UiAutomator2 driver refuses a session without this exported, and
  // it is not set on every machine that can otherwise run adb — this one
  // included, which is how a real run failed at session creation.
  it('derives the SDK root from the configured adb path', () => {
    expect(resolveAndroidSdkRoot('C:/Users/x/AppData/Local/Android/Sdk/platform-tools/adb.exe')).toBe(
      'C:/Users/x/AppData/Local/Android/Sdk',
    );
  });

  it('returns null for an adb path that is not inside platform-tools', () => {
    // Better to report "unknown" than to export a wrong root that fails later
    // in a more confusing way.
    expect(resolveAndroidSdkRoot('/usr/local/bin/adb')).toBeNull();
  });

  it('returns null when there is no adb path to work from', () => {
    expect(resolveAndroidSdkRoot(undefined)).toBeNull();
  });
});
