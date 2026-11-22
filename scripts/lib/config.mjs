/**
 * Env-derived config shared by start.mjs and stop.mjs. Same defaults as the
 * old start.sh/stop.sh (which each resolved SDK_ROOT/ADB_PATH independently,
 * duplicated) — consolidated here since both scripts already need to import
 * from lib/ anyway, not a scope change.
 */
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultAdbPath, defaultEmulatorBin, isWindows, isMac } from './platform.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Same default as the old `${MOBILEHUB_LOG_DIR:-/tmp/mobile-hub}` — os.tmpdir()
// is the portable equivalent of /tmp (Bash-only on Windows).
export const LOG_DIR = process.env.MOBILEHUB_LOG_DIR ?? path.join(os.tmpdir(), 'mobile-hub');
export const PIDFILE = path.join(LOG_DIR, 'pids.json');

export const AVD_NAME = process.env.AVD_NAME ?? 'Pixel_3a_API_34_extension_level_7_x86_64';
export const ADB_PATH = defaultAdbPath();
export const EMULATOR_BIN = defaultEmulatorBin();
// Where the AVD's disk images and lock files live (the emulator's own default).
export const AVD_DIR = path.join(
  process.env.ANDROID_AVD_HOME ?? path.join(os.homedir(), '.android', 'avd'),
  `${AVD_NAME}.avd`,
);
// Window off unless asked for: the device is driven over adb and viewed
// through the hub's own stream, so a desktop window is only a debugging aid.
export const EMULATOR_WINDOW = process.env.EMULATOR_WINDOW === '1';

export const MONGO_CONTAINER = process.env.MONGO_CONTAINER ?? 'mh-mongo';
export const MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/mobilehub_dev';
export const JWT_SECRET = process.env.JWT_SECRET ?? 'dev_only_not_a_real_secret_32chars_min';
export const AGENT_TOKEN = process.env.AGENT_TOKEN ?? 'dev_agent_token_1234567890';
export const MACHINE_ID = process.env.MACHINE_ID ?? 'dev-host';
export const API_PORT = process.env.API_PORT ?? '3000';
// Not env-overridable: frontend/vite.config.ts hardcodes `port: 5173` with no
// env var read, so a FRONTEND_PORT override here would be fiction — nothing
// downstream would actually listen there. A literal matching that config.
export const FRONTEND_PORT = '5173';

export const DOCKER_DESKTOP_EXE =
  process.env.DOCKER_DESKTOP_EXE ??
  (isWindows ? 'C:/Program Files/Docker/Docker/Docker Desktop.exe' : isMac ? null : null);

export function log(msg) {
  console.log(`[mobile-hub] ${msg}`);
}

export function die(msg) {
  console.error(`[mobile-hub] ERROR: ${msg}`);
  process.exit(1);
}
