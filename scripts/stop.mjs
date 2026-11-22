#!/usr/bin/env node
/**
 * Stops everything start.mjs starts: backend, frontend, host agent, and the
 * Android emulator. Mongo is deliberately left running (see bottom) — same
 * behavior as the old stop.sh.
 *
 * Tree-kill, not a plain kill: an `npm run dev`/`tsx watch` process has the
 * real worker as a child, and killing only the parent once left 66 orphaned
 * node processes on this machine (docs/LESSONS.md). And we don't trust a PID
 * recorded at spawn time for the emulator — a shell's own notion of "the
 * PID it started" doesn't reliably match what the OS needs to kill for a
 * native GUI binary — so the emulator is found and killed by process name,
 * verified by re-querying afterward, not by trusting the kill call's return.
 */
import { readdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { ADB_PATH, API_PORT, AVD_DIR, FRONTEND_PORT, PIDFILE, log } from './lib/config.mjs';
import { findProcessByPort, findProcesses, isWindows, killByName, killTree, tryRun } from './lib/platform.mjs';

async function readPidfile() {
  if (!existsSync(PIDFILE)) return [];
  try {
    const raw = await readFile(PIDFILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Backstop for backend/frontend: whatever the OS says is actually listening
 * on their known port, right now, gets tree-killed and the kill verified by
 * re-checking the port — the same "ask the OS, don't trust a PID from
 * earlier" idiom stopEmulator() below already uses successfully. Needed
 * because the recorded PID is the npm/cmd wrapper's, which can have already
 * exited on its own while the real worker (the process actually holding the
 * port) lives on under a different PID — see findProcessByPort's own doc
 * comment for how this was confirmed live, not assumed.
 */
async function stopByPort(name, port) {
  const pid = await findProcessByPort(port);
  if (!pid) return;
  const ok = await killTree(pid);
  log(
    ok
      ? `stopped ${name} (pid ${pid}, found via port ${port} — the recorded spawn-time PID had already gone stale)`
      : `could not stop ${name} (pid ${pid}, found via port ${port})`,
  );
}

async function stopRecordedProcesses() {
  const entries = await readPidfile();
  const toKill = entries.filter((e) => e.name !== 'emulator');

  if (toKill.length === 0) {
    log('no recorded backend/frontend/agent processes to stop.');
  }

  for (const { name, pid } of toKill) {
    const ok = await killTree(pid);
    log(ok ? `stopped ${name} (pid ${pid})` : `could not stop ${name} (pid ${pid}) — may already be gone`);
  }

  await stopByPort('backend', API_PORT);
  await stopByPort('frontend', FRONTEND_PORT);

  // The agent doesn't hold a port, so it has no port-based backstop — fall
  // back to the same kill-by-command-line-substring approach stopEmulator()
  // already uses for a native binary with no listening port either.
  const agentKilled = await killByName('agent/main.ts');
  if (agentKilled > 0) {
    log(`stopped ${agentKilled} agent process(es) found by command line — a recorded PID may have gone stale`);
  }

  if (existsSync(PIDFILE)) await rm(PIDFILE, { force: true });
}

async function stopEmulator() {
  // Clean shutdown attempt first.
  await tryRun(ADB_PATH, ['emu', 'kill'], 15000);

  const emulatorNames = isWindows ? ['emulator.exe', 'qemu-system-x86_64.exe'] : ['emulator', 'qemu-system-x86_64'];

  let killedAny = false;
  for (const name of emulatorNames) {
    const procs = await findProcesses(name);
    for (const p of procs) {
      await killTree(p.pid);
      killedAny = true;
    }
  }

  // Verify by re-querying rather than trusting the kill calls' own return values.
  await new Promise((r) => setTimeout(r, 1500));
  const stillRunning = [];
  for (const name of emulatorNames) {
    stillRunning.push(...(await findProcesses(name)));
  }

  if (stillRunning.length > 0) {
    log(`WARNING: emulator process(es) still present after kill attempt: ${stillRunning.map((p) => p.pid).join(', ')}`);
  } else if (killedAny) {
    log('emulator stopped and verified gone.');
  } else {
    log('no emulator process was running.');
  }

  // A crashed emulator leaves its locks behind (hardware-qemu.ini.lock is a
  // directory), and every later boot then fails as "multiple instances".
  // Only safe to clear once nothing is running — verified just above.
  if (stillRunning.length === 0 && existsSync(AVD_DIR)) {
    for (const name of (await readdir(AVD_DIR)).filter((n) => n.endsWith('.lock'))) {
      await rm(path.join(AVD_DIR, name), { recursive: true, force: true });
      log(`cleared stale AVD lock ${name}.`);
    }
  }

  return stillRunning.length === 0;
}

export async function stopAll() {
  log('stopping mobile-hub stack...');
  await stopRecordedProcesses();
  await stopEmulator();
  log('Mongo left running intentionally (docker stop mh-mongo to stop it too).');
}

// True when this file was run directly (`node scripts/stop.mjs`) rather than imported.
// process.argv[1] can be relative (e.g. run from the repo root) — resolve it
// before comparing against import.meta.url's always-absolute path.
function invokedDirectly() {
  if (!process.argv[1]) return false;
  const norm = (s) => s.replace(/\\/g, '/').toLowerCase();
  const thisPath = norm(decodeURIComponent(new URL(import.meta.url).pathname).replace(/^\/([a-zA-Z]:)/, '$1'));
  return thisPath === norm(path.resolve(process.argv[1]));
}

if (invokedDirectly()) {
  stopAll();
}
