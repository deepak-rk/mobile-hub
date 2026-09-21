import { spawn, ChildProcess, execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * One place child processes are launched, supervised, and killed.
 *
 * This exists because the same class of process bug has now bitten this repo
 * repeatedly in unrelated modules (see docs/LESSONS.md): `spawn('npm')`
 * failing with ENOENT on Windows, an `adb` child hanging because stdin was
 * left open, killing a wrapper PID instead of the real worker, a process tree
 * surviving cancellation, and a spawn-level rejection leaving caller state
 * stuck mid-flight. Each was fixed locally; the class kept recurring.
 *
 * Deliberately repo-local, not a seventh extracted package — it consolidates a
 * failure class first and can be extracted later if a second consumer proves
 * it generic.
 */

/**
 * Every way a child can finish, as data rather than a thrown error.
 *
 * A spawn-level failure (ENOENT) is an *outcome*, not an exception: the
 * previous design rejected the promise, the caller's catch marked the run
 * failed, and nothing ever updated the in-flight stage — so a run showed
 * "failed" with a stage stuck on "running" forever. Returning an outcome for
 * every path makes it impossible to skip that update.
 */
export type RunOutcome =
  | { kind: 'exited'; exitCode: number }
  | { kind: 'signalled'; signal: NodeJS.Signals }
  | { kind: 'spawn-failed'; message: string }
  | { kind: 'timeout' }
  | { kind: 'cancelled' };

/** True when the child ran to completion and reported success. */
export function isSuccess(outcome: RunOutcome): boolean {
  return outcome.kind === 'exited' && outcome.exitCode === 0;
}

/** A short, human-readable reason suitable for a stage `error` field. */
export function describeOutcome(outcome: RunOutcome): string {
  switch (outcome.kind) {
    case 'exited':
      return `exit code ${String(outcome.exitCode)}`;
    case 'signalled':
      return `killed by ${outcome.signal}`;
    case 'spawn-failed':
      return `could not start process: ${outcome.message}`;
    case 'timeout':
      return 'timed out';
    case 'cancelled':
      return 'cancelled';
  }
}

/**
 * Resolves a bare command name to a real executable on Windows.
 *
 * Node's `spawn` without `shell: true` does not apply PATHEXT, so `npm` (a
 * `npm.cmd` shim) fails with ENOENT — confirmed live. This resolves the real
 * path so the caller knows exactly what it's spawning; `run()` below still
 * has to pass `shell: true` for a resolved `.cmd`/`.bat` specifically, since
 * recent Node versions refuse to spawn one directly at all (`EINVAL` — see
 * `run()`'s own comment). Resolving the extension explicitly here, rather
 * than leaning on `shell: true` alone, is what lets that decision be made
 * per-extension instead of shelling out for every command.
 *
 * Returns the input unchanged on POSIX, when already extended, or when nothing
 * matches (letting spawn produce its own normal error).
 */
export function resolveExecutable(command: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return command;
  if (path.extname(command)) return command;

  const exts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);

  // An explicit path: only try extensions against that exact location.
  if (command.includes('/') || command.includes('\\')) {
    for (const ext of exts) {
      const candidate = command + ext.toLowerCase();
      if (fs.existsSync(candidate)) return candidate;
    }
    return command;
  }

  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext.toLowerCase());
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return command;
}

/**
 * Kills a process and everything it spawned.
 *
 * A test runner is a tree (npm → node → wdio → …); killing only the direct
 * child orphans the rest, which on a device farm means an orphaned process
 * still holding a device. Windows has no process groups, so `taskkill /T`
 * does the tree walk; POSIX uses a negative pid against the group the child
 * was detached into.
 */
export function killTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (child.pid === undefined || child.exitCode !== null) return;

  if (process.platform === 'win32') {
    // /T = tree, /F = force. Best-effort: the process may already be gone,
    // which taskkill reports as an error we deliberately ignore.
    execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => {});
    return;
  }
  try {
    process.kill(-child.pid, signal); // negative pid = the whole process group
  } catch {
    // Group already gone, or never became a group leader — fall back to the
    // direct child so a cancel still does something.
    try {
      child.kill(signal);
    } catch {
      // Already dead; nothing to do.
    }
  }
}

export interface RunOptions {
  command: string;
  args: string[];
  cwd: string;
  /**
   * The child's complete environment. Deliberately NOT merged with
   * `process.env` here — callers that need inheritance must opt in explicitly,
   * because a test runner inheriting the hub's full environment is how secrets
   * reach a crash log (a real failure mode observed in this workspace: the
   * Android emulator's crash reporter dumps the whole process environment).
   */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  onStdout?: (chunk: Buffer) => void;
  onStderr?: (chunk: Buffer) => void;
}

export interface ManagedProcess {
  /** Resolves with a normalized outcome. Never rejects for a process-level failure. */
  readonly result: Promise<RunOutcome>;
  /** The real worker pid, or undefined if the spawn itself failed. */
  readonly pid: number | undefined;
  /** Terminates the whole process tree; `result` settles as `cancelled`. */
  cancel(): void;
}

/**
 * Spawns a supervised child. See `RunOutcome` — this never rejects for a
 * process-level failure, so a caller can always update its own state.
 */
export function run(opts: RunOptions): ManagedProcess {
  let settle!: (outcome: RunOutcome) => void;
  const result = new Promise<RunOutcome>((resolve) => {
    settle = resolve;
  });

  let settled = false;
  const finish = (outcome: RunOutcome): void => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    settle(outcome);
  };

  const resolved = resolveExecutable(opts.command);
  const child = spawn(resolved, opts.args, {
    cwd: opts.cwd,
    env: opts.env,
    // Explicit stdio: an inherited/open stdin has left `adb` children hanging
    // here before (docs/LESSONS.md). Nothing we spawn reads stdin.
    stdio: ['ignore', 'pipe', 'pipe'],
    // POSIX: become a group leader so killTree can signal the whole group.
    // Windows has no groups; taskkill /T handles the tree instead.
    detached: process.platform !== 'win32',
    // A `.cmd`/`.bat` resolved by resolveExecutable above cannot be spawned
    // directly on Windows: recent Node versions reject it with `spawn EINVAL`
    // rather than silently shelling out to it, closing a command-injection
    // class the old implicit behavior allowed (confirmed live 2026-09-21 — a
    // real `npm ci` install stage failed this way against a real Node 22
    // install; `npm --version` reproduced the same EINVAL in isolation, and
    // `shell: true` resolved it cleanly). Scoped to only these two extensions
    // rather than every command, since a real `.exe` spawns fine as-is and
    // gains nothing from the extra shell hop. `killTree`'s Windows path uses
    // `taskkill /PID <pid> /T /F` — a tree-kill by PID, not a POSIX signal —
    // so it still reaches the whole tree (cmd.exe -> npm.cmd -> node) through
    // this shell hop the same as without it; the "shell breaks cancellation"
    // constraint this file used to carry was a POSIX-signal concern that
    // doesn't apply to Windows's tree-kill mechanism.
    shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolved),
  });

  let cancelled = false;
  let timedOut = false;

  const timer = opts.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        killTree(child, 'SIGKILL');
      }, opts.timeoutMs)
    : null;

  child.stdout?.on('data', (chunk: Buffer) => opts.onStdout?.(chunk));
  child.stderr?.on('data', (chunk: Buffer) => opts.onStderr?.(chunk));

  child.on('error', (err) => finish({ kind: 'spawn-failed', message: err.message }));

  child.on('exit', (code, signal) => {
    if (timedOut) return finish({ kind: 'timeout' });
    if (cancelled) return finish({ kind: 'cancelled' });
    if (code !== null) return finish({ kind: 'exited', exitCode: code });
    if (signal !== null) return finish({ kind: 'signalled', signal });
    // Neither a code nor a signal shouldn't happen, but must not hang forever.
    finish({ kind: 'spawn-failed', message: 'process exited with neither a code nor a signal' });
  });

  return {
    result,
    get pid() {
      return child.pid;
    },
    cancel() {
      cancelled = true;
      killTree(child, 'SIGTERM');
    },
  };
}
