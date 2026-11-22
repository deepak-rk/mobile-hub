import * as path from 'path';

/**
 * Builds the environment a test run's child processes get, and the redactor
 * that keeps its secrets out of the log.
 *
 * The child does NOT inherit the hub's environment. That is deliberate and it
 * is the load-bearing half: this workspace has already seen a child process
 * dump its whole inherited environment into a crash report (the Android
 * emulator's crash reporter does exactly that), so "our code never prints the
 * secret" is not a sufficient defence. What a runner cannot see, it cannot
 * leak.
 */

/**
 * Variables passed through from the hub's own environment.
 *
 * Everything here is needed for a process to run at all — resolve binaries,
 * find a home directory, write temp files — and none of it is a credential.
 * A tool needing something else gets it declared in `automation.env`, where it
 * is visible in config review rather than inherited by accident.
 */
const PASSTHROUGH = [
  'PATH',
  'Path',
  'HOME',
  'USERPROFILE',
  'SystemRoot',
  'windir',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'NODE_PATH',
  // Android tooling resolves the SDK through these; without them adb and the
  // emulator are simply not findable from a child.
  'ANDROID_HOME',
  'ANDROID_SDK_ROOT',
  'JAVA_HOME',
  // npm/npx on Windows resolve their own shims relative to these.
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramFiles',
  'ProgramData',
  'COMSPEC',
  'PATHEXT',
  'SystemDrive',
  'HOMEDRIVE',
  'HOMEPATH',
];

/**
 * Where the Android SDK lives, for tools that insist on being told.
 *
 * Appium's UiAutomator2 driver refuses to start a session without
 * `ANDROID_HOME` or `ANDROID_SDK_ROOT`, and neither is set on every machine
 * that can nonetheless run adb perfectly well — this one included. Rather than
 * make that a setup instruction, it is derived from the adb path the hub is
 * already configured with: adb lives at `<sdk>/platform-tools/adb`, so the
 * root is two directories up.
 *
 * Returns null when it genuinely cannot be determined, so a caller reports
 * that instead of exporting a wrong path that fails more confusingly later.
 */
export function resolveAndroidSdkRoot(adbPath = process.env.ADB_PATH): string | null {
  const declared = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  if (declared) return declared;
  if (!adbPath) return null;

  const platformTools = path.dirname(adbPath);
  if (path.basename(platformTools).toLowerCase() !== 'platform-tools') return null;
  return path.dirname(platformTools);
}

export interface RunEnvironmentInput {
  /** Declared per project/org. Treated as secret. */
  configured: Record<string, string>;
  /** Coordinates of the Appium server this run should talk to, when there is one. */
  appium?: { host: string; port: number; baseUrl: string; path?: string };
  /** Identifies the device under test to the runner. */
  device?: { udid: string; platform: string; osVersion: string; name: string };
  /** The build to install/target, when the run has one. */
  appPath?: string;
  /** This run's id, so a suite can tag its own artifacts with it. */
  runId?: string;
  /** The project variant, passed as VARIANT. */
  variant?: string | null;
}

/** The Appium driver each platform needs — what WDIO sends as `appium:automationName`. */
const AUTOMATION_NAME: Record<string, string> = { android: 'UiAutomator2', ios: 'XCUITest' };

export function buildRunEnvironment(input: RunEnvironmentInput): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of PASSTHROUGH) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }

  // Declared values FIRST, so the per-run values below always win. This was
  // the other way round ("an org that sets APPIUM_HOST for a remote grid
  // should win"), but configured env is org- or project-wide while these are
  // per-run facts: a configured APPIUM_HOST, DEVICE_UDID or PLATFORM pins
  // every run to one host or device, which is wrong for all the others. A
  // production farm in this domain hit exactly this — the test repo's own
  // hardcoded remote Appium host survived because the hub only wrote its
  // value when one was missing — and its rule is: always write the per-run
  // values. A remote grid is configured through `appium.host`, which feeds
  // the derived value, not by overriding it here.
  Object.assign(env, input.configured);

  // Derived rather than required: the hub already knows where adb is, and a
  // session cannot start without the SDK root being exported.
  const sdkRoot = resolveAndroidSdkRoot();
  if (sdkRoot) {
    env.ANDROID_HOME = sdkRoot;
    env.ANDROID_SDK_ROOT = sdkRoot;
  }

  // Named to match what the sibling wdio-mobile-appium-automation repo's
  // config/env.ts already reads, so a suite works against the hub without
  // being rewritten for it.
  if (input.appium) {
    env.APPIUM_HOST = input.appium.host;
    env.APPIUM_PORT = String(input.appium.port);
    // The base path is part of where the server lives: a server on the legacy
    // `/wd/hub` path 404s every session created against the bare origin.
    env.APPIUM_PATH = input.appium.path || '/';
    env.APPIUM_BASE_URL = `${input.appium.baseUrl}${input.appium.path ?? ''}`;
  }
  if (input.device) {
    env.DEVICE_UDID = input.device.udid;
    env.DEVICE_NAME = input.device.name;
    env.PLATFORM = input.device.platform;
    env.PLATFORM_VERSION = input.device.osVersion;
    const automationName = AUTOMATION_NAME[input.device.platform];
    if (automationName) env.AUTOMATION_NAME = automationName;
  }
  if (input.appPath) env.APP_PATH = input.appPath;
  if (input.runId) env.RUN_ID = input.runId;
  // Per-run, like the values above: a configured VARIANT must not pin every run.
  if (input.variant) env.VARIANT = input.variant;
  else delete env.VARIANT;
  return env;
}

/**
 * Masks configured secret values wherever they appear in output.
 *
 * Operates on the *values* rather than on known key names, because a secret
 * leaks by being printed, not by being named — a runner echoing its config, or
 * a stack trace embedding a URL with a token in it, prints the value with no
 * mention of the key it came from.
 */
export function createRedactor(configured: Record<string, string>): (text: string) => string {
  // Short values would turn ordinary output into a wall of asterisks — "true",
  // "1" or "dev" appear everywhere and are not credentials.
  const secrets = Object.values(configured)
    .filter((v) => v.length >= 6)
    // Longest first, so an overlapping shorter secret can't partially mask a
    // longer one and leave a recognisable tail behind.
    .sort((a, b) => b.length - a.length);

  if (secrets.length === 0) return (text) => text;

  return (text) => {
    let out = text;
    for (const secret of secrets) out = out.split(secret).join('***');
    return out;
  };
}
