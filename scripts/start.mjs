#!/usr/bin/env node
/**
 * Boots the full local dev stack: Mongo, the Android emulator, backend,
 * frontend, host agent. Idempotent — each step is skipped if that component
 * is already up, except the host agent (matches old start.sh, which always
 * (re)started it). Calls stop.mjs first for a clean slate before laying
 * anything down, same reasoning as before: layering a new backend/frontend
 * on top of stale ones from a previous crashed run is how zombies happen.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

import {
  ROOT,
  LOG_DIR,
  PIDFILE,
  AVD_NAME,
  ADB_PATH,
  EMULATOR_BIN,
  EMULATOR_WINDOW,
  MONGO_CONTAINER,
  MONGODB_URI,
  JWT_SECRET,
  AGENT_TOKEN,
  MACHINE_ID,
  API_PORT,
  DOCKER_DESKTOP_EXE,
  log,
  die,
} from './lib/config.mjs';
import { isWindows, isMac, tryRun } from './lib/platform.mjs';
import { stopAll } from './stop.mjs';

const recordedPids = [];

// Written immediately, not batched at the end — if start.mjs dies partway
// through, stop.mjs should still be able to find and kill whatever did get
// spawned, the same guarantee the old start.sh's per-step `>> "$PIDFILE"` gave.
async function recordPid(name, pid) {
  recordedPids.push({ name, pid });
  await writeFile(PIDFILE, JSON.stringify(recordedPids, null, 2));
}

async function urlOk(url, timeoutMs = 2000) {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

/** Spawns a long-running child, detached from this process's own lifecycle, output redirected to a log file. */
async function spawnLogged(name, cmd, args, opts) {
  const logFile = path.join(LOG_DIR, `${name}.log`);
  const fd = await import('node:fs').then((fs) => fs.openSync(logFile, 'a'));
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdio: ['ignore', fd, fd],
    detached: !isWindows,
    shell: isWindows, // npm.cmd on Windows needs a shell to resolve
    windowsHide: true,
  });
  child.unref();
  await recordPid(name, child.pid);
  log(`started ${name} (pid ${child.pid}), logging to ${logFile}`);
  return child;
}

async function preflight() {
  const dockerCheck = await tryRun('docker', ['--version']);
  if (!dockerCheck.ok) die('docker is not on PATH.');

  if (!existsSync(ADB_PATH)) die(`adb not found at ${ADB_PATH} (set ADB_PATH to override).`);
  if (!existsSync(EMULATOR_BIN)) die(`emulator binary not found at ${EMULATOR_BIN} (set EMULATOR_BIN to override).`);
}

async function ensureDockerRunning() {
  const info = await tryRun('docker', ['info'], 10000);
  if (info.ok) return;

  log('Docker daemon not reachable, attempting to launch Docker Desktop...');
  if (isWindows) {
    if (!DOCKER_DESKTOP_EXE || !existsSync(DOCKER_DESKTOP_EXE)) {
      die(`Docker daemon is not running and Docker Desktop was not found at ${DOCKER_DESKTOP_EXE}.`);
    }
    spawn(DOCKER_DESKTOP_EXE, [], { detached: true, stdio: 'ignore' }).unref();
  } else if (isMac) {
    await tryRun('open', ['-a', 'Docker']);
  } else {
    die('Docker daemon is not running. Start it (e.g. `systemctl start docker`) and re-run.');
  }

  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const retry = await tryRun('docker', ['info'], 10000);
    if (retry.ok) {
      log('Docker daemon is up.');
      return;
    }
  }
  die('Docker daemon did not become reachable within 5 minutes.');
}

async function ensureMongo() {
  const running = await tryRun('docker', ['ps', '--filter', `name=^${MONGO_CONTAINER}$`, '--format', '{{.Names}}']);
  if (running.ok && running.stdout.trim() === MONGO_CONTAINER) {
    log(`Mongo container "${MONGO_CONTAINER}" already running.`);
    return;
  }

  const existing = await tryRun('docker', ['ps', '-a', '--filter', `name=^${MONGO_CONTAINER}$`, '--format', '{{.Names}}']);
  if (existing.ok && existing.stdout.trim() === MONGO_CONTAINER) {
    log(`Starting existing Mongo container "${MONGO_CONTAINER}"...`);
    await tryRun('docker', ['start', MONGO_CONTAINER], 30000);
    return;
  }

  log(`Creating Mongo container "${MONGO_CONTAINER}"...`);
  const created = await tryRun(
    'docker',
    ['run', '-d', '-p', '27017:27017', '--name', MONGO_CONTAINER, 'mongo:7'],
    60000,
  );
  if (!created.ok) die(`failed to create Mongo container "${MONGO_CONTAINER}".`);
}

// Only what the emulator needs to find the SDK, the AVD, temp space and
// system DLLs. Its crash reporter records the whole inherited environment,
// so anything else (API tokens set machine-wide) is left out.
const EMULATOR_ENV_KEYS = new Set([
  'PATH', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE',
  'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'APPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'COMSPEC',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'USERNAME', 'USER', 'DISPLAY',
  'XDG_RUNTIME_DIR', 'LD_LIBRARY_PATH',
]);
function emulatorEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([k]) => EMULATOR_ENV_KEYS.has(k.toUpperCase()) || k.toUpperCase().startsWith('ANDROID_')),
  );
}

async function ensureEmulator() {
  // NOTE: on Windows, emulator.exe's crashpad reporter dumps the full process
  // environment into its log file — never cat/tail that log raw (docs/LESSONS.md).
  const devices = await tryRun(ADB_PATH, ['devices']);
  if (devices.ok && /^emulator-/m.test(devices.stdout)) {
    log('Android emulator already running.');
    return;
  }

  log(`Booting Android emulator (${AVD_NAME}, ${EMULATOR_WINDOW ? 'windowed' : 'headless'})...`);
  // Flags chosen for stability on an ordinary laptop, not speed:
  // - software GPU (swiftshader): the host GPU driver path ("auto") crashed
  //   the emulator repeatedly on a hybrid Intel+NVIDIA laptop; software
  //   rendering takes the driver out of the picture entirely.
  // - cold boot, no snapshot: a half-written snapshot from a crash is
  //   another way to crash on the next start.
  // - 2 cores / 2 GB: an AVD config can ask for every host core (this one
  //   asked for 10), starving the hub and the browser beside it.
  // Output goes nowhere (see the NOTE above) and the child gets only the
  // environment it needs, so a crash dump cannot carry unrelated secrets.
  const args = ['-avd', AVD_NAME, '-gpu', 'swiftshader_indirect', '-no-snapshot', '-no-boot-anim', '-no-audio', '-cores', '2', '-memory', '2048'];
  if (!EMULATOR_WINDOW) args.push('-no-window');
  const child = spawn(EMULATOR_BIN, args, {
    stdio: 'ignore',
    detached: true,
    windowsHide: true,
    env: emulatorEnv(),
  });
  child.unref();
  await recordPid('emulator', child.pid);

  await tryRun(ADB_PATH, ['wait-for-device'], 120000);

  log('Waiting for emulator boot to complete...');
  for (let i = 0; i < 150; i++) {
    const boot = await tryRun(ADB_PATH, ['shell', 'getprop', 'sys.boot_completed'], 10000);
    if (boot.ok && boot.stdout.trim() === '1') {
      log('Emulator boot completed.');
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  log('WARNING: emulator did not report boot_completed within the expected time — continuing anyway.');
}

async function ensureBackend() {
  if (await urlOk(`http://localhost:${API_PORT}/health`)) {
    log('Backend already responding on /health.');
    return;
  }

  await spawnLogged('backend', 'npm', ['run', 'dev'], {
    cwd: path.join(ROOT, 'backend'),
    env: {
      ADB_PATH,
      MONGODB_URI,
      JWT_SECRET,
      AGENT_TOKEN,
      API_PORT,
      NODE_ENV: 'development',
    },
  });

  for (let i = 0; i < 30; i++) {
    if (await urlOk(`http://localhost:${API_PORT}/health`)) {
      log('Backend is up.');
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  log('WARNING: backend did not respond on /health within 30s — check .mobilehub-logs/backend.log.');
}

async function ensureFrontend() {
  if (await urlOk('http://localhost:5173')) {
    log('Frontend already responding.');
    return;
  }

  await spawnLogged('frontend', 'npm', ['run', 'dev'], {
    cwd: path.join(ROOT, 'frontend'),
    env: {},
  });
}

async function startAgent() {
  await spawnLogged('agent', 'npm', ['run', 'agent'], {
    cwd: path.join(ROOT, 'backend'),
    env: {
      ADB_PATH,
      HUB_URL: `http://localhost:${API_PORT}`,
      MACHINE_ID,
      AGENT_TOKEN,
    },
  });
}

async function main() {
  await mkdir(LOG_DIR, { recursive: true });

  await preflight();
  await ensureDockerRunning();

  log('stopping any existing mobile-hub processes for a clean slate...');
  await stopAll();

  await ensureMongo();
  await ensureEmulator();
  await ensureBackend();
  await ensureFrontend();
  await startAgent();

  log('');
  log('mobile-hub stack is up:');
  log(`  backend:   http://localhost:${API_PORT}`);
  log(`  frontend:  http://localhost:5173`);
  log(`  logs:      ${LOG_DIR}`);
  log('Run `node scripts/stop.mjs` (or `npm run stop`) to stop everything.');
}

main().catch((err) => {
  die(err?.stack ?? String(err));
});
