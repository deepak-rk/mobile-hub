import { describe, it, expect, afterEach } from 'vitest';
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

  it('lets configured values override what the hub inferred', () => {
    // An org pointing at a remote grid should win over the local endpoint.
    const env = buildRunEnvironment({
      configured: { APPIUM_BASE_URL: 'https://grid.example.com' },
      appium: { host: '127.0.0.1', port: 4723, baseUrl: 'http://127.0.0.1:4723' },
    });
    expect(env.APPIUM_BASE_URL).toBe('https://grid.example.com');
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
