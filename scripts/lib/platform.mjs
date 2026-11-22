/**
 * The few things that genuinely cannot be done portably in Node, isolated here
 * so start.mjs/stop.mjs stay platform-agnostic. Same pattern as the sibling
 * appium-server-setup repo's bin/lib/platform.mjs — see docs/LESSONS.md
 * (2026-08-29) for why these scripts moved off Bash+Windows-only tools
 * (taskkill, wmic, Windows-format netstat parsing) in the first place.
 */
import { execFile } from 'node:child_process';
import net from 'node:net';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const isWindows = process.platform === 'win32';
export const isMac = process.platform === 'darwin';

/**
 * True if nothing is listening on `port`.
 *
 * Done by attempting to bind rather than by parsing `netstat`/`lsof` output,
 * whose formats differ per OS and per version. Binding answers the only
 * question that actually matters — "can a server take this port?" — the same
 * way everywhere.
 */
export function isPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}

/** Polls `isPortFree` until it answers `false` (something is listening) or the timeout elapses. */
export async function waitForPortInUse(port, host = '127.0.0.1', timeoutMs = 30_000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isPortFree(port, host))) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/**
 * Processes whose command line matches `pattern`, as `{ pid, command }`.
 *
 * Irreducibly platform-specific: Windows exposes command lines via WMI/CIM,
 * Unix via `ps`. Both are read-only queries with a bounded timeout.
 */
export async function findProcesses(pattern) {
  try {
    if (isWindows) {
      // PowerShell rather than the deprecated wmic, which is absent from newer Windows.
      const script =
        "Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress";
      const { stdout } = await run('powershell', ['-NoProfile', '-Command', script], {
        timeout: 20000,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      });
      if (!stdout.trim()) return [];
      const parsed = JSON.parse(stdout);
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      return rows
        .filter((r) => (r.CommandLine && r.CommandLine.includes(pattern)) || (r.Name && r.Name.includes(pattern)))
        .map((r) => ({ pid: r.ProcessId, command: r.CommandLine ?? r.Name }));
    }

    // macOS and Linux: `ps -eo pid=,args=` is portable across both.
    const { stdout } = await run('ps', ['-eo', 'pid=,args='], { timeout: 20000, maxBuffer: 16 * 1024 * 1024 });
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.includes(pattern) && !line.includes('ps -eo'))
      .map((line) => {
        const [pid, ...rest] = line.split(/\s+/);
        return { pid: Number(pid), command: rest.join(' ') };
      })
      .filter((p) => Number.isFinite(p.pid));
  } catch {
    // A failed query means "cannot tell", which callers treat as "found
    // nothing" rather than crashing a stop/start over an introspection failure.
    return [];
  }
}

/**
 * Kills a process and its children (tree-kill).
 *
 * The tree part matters: an `npm run dev`/`tsx watch` process has the real
 * worker as a child, and killing only the parent leaves that worker alive
 * still holding its port — a whole session's worth of restarts done the naive
 * way once left 66 orphaned node processes behind on this exact machine (see
 * docs/LESSONS.md). Reliable regardless of whether the PID came from a
 * shell's own `$!` (which, for a spawned native GUI binary, doesn't always
 * match what the OS actually needs to kill it — also in docs/LESSONS.md).
 */
export async function killTree(pid) {
  try {
    if (isWindows) {
      await run('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 15000, windowsHide: true });
    } else {
      try {
        process.kill(-pid, 'SIGKILL'); // negative pid targets the whole process group
      } catch {
        process.kill(pid, 'SIGKILL');
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * The PID of whatever is currently listening on `port`, or null.
 *
 * More reliable than a PID recorded at spawn time for stopping a dev server.
 * `spawn('npm', ['run', 'dev'], { shell: true })` on Windows returns the
 * wrapper's PID (cmd.exe / npm-cli.js) — by the time stop.mjs runs, that
 * wrapper can have already exited on its own while the actual `tsx
 * watch`/vite worker (the process really holding the port) is still alive
 * under a completely different PID. `taskkill /T` tree-kill can't find a
 * lineage whose parent has already exited, so it reports "process not
 * found" and silently leaves the real worker running — confirmed live, not
 * hypothetical: the recorded PID was gone while the port was still bound and
 * serving requests. Asking the OS "who's on this port right now" sidesteps
 * the whole PID-lineage question entirely.
 */
export async function findProcessByPort(port) {
  try {
    if (isWindows) {
      const script = `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)`;
      const { stdout } = await run('powershell', ['-NoProfile', '-Command', script], {
        timeout: 10000,
        windowsHide: true,
      });
      const pid = Number(stdout.trim());
      return Number.isFinite(pid) && pid > 0 ? pid : null;
    }
    const { stdout } = await run('lsof', ['-ti', `:${port}`], { timeout: 10000 });
    const pid = Number(stdout.trim().split('\n')[0]);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** The Android SDK root, derived from the environment rather than hardcoded to one machine's username. */
export function resolveAndroidHome() {
  const explicit = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (explicit && existsSync(explicit)) return explicit;

  const home = process.env.HOME || process.env.USERPROFILE || '';
  const candidates = isWindows
    ? [path.join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk')]
    : isMac
      ? [path.join(home, 'Library', 'Android', 'sdk')]
      : [path.join(home, 'Android', 'Sdk'), '/usr/lib/android-sdk'];

  return candidates.find((c) => c && existsSync(c)) ?? null;
}

/** Default adb path per platform, overridable via ADB_PATH. */
export function defaultAdbPath() {
  if (process.env.ADB_PATH) return process.env.ADB_PATH;
  const sdk = resolveAndroidHome();
  if (sdk) return path.join(sdk, 'platform-tools', isWindows ? 'adb.exe' : 'adb');
  return isWindows ? 'adb.exe' : 'adb';
}

/** Default emulator binary path per platform, overridable via EMULATOR_BIN. */
export function defaultEmulatorBin() {
  if (process.env.EMULATOR_BIN) return process.env.EMULATOR_BIN;
  const sdk = resolveAndroidHome();
  if (sdk) return path.join(sdk, 'emulator', isWindows ? 'emulator.exe' : 'emulator');
  return isWindows ? 'emulator.exe' : 'emulator';
}

/** Runs a command with a hard timeout, returning `{ ok, stdout }` rather than throwing. */
export async function tryRun(cmd, args, timeout = 20000) {
  try {
    const { stdout } = await run(cmd, args, { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    return { ok: true, stdout: stdout ?? '' };
  } catch (err) {
    return { ok: false, stdout: err?.stdout ?? '' };
  }
}
