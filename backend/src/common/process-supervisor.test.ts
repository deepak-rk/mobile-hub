import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { run, resolveExecutable, isSuccess, describeOutcome, RunOutcome } from './process-supervisor';

/**
 * The properties this module exists to guarantee, each tied to a real bug it
 * was written to end (docs/LESSONS.md): a `.cmd` shim resolves on Windows, a
 * failed spawn is an outcome rather than a throw, and a cancel takes the whole
 * tree down.
 *
 * Real child processes throughout — mocking `child_process` here would test
 * nothing, since every one of those bugs lived in the real spawn behaviour.
 */
describe('resolveExecutable', () => {
  it('leaves commands untouched on posix', () => {
    expect(resolveExecutable('npm', 'linux')).toBe('npm');
    expect(resolveExecutable('git', 'darwin')).toBe('git');
  });

  it('leaves an already-extended command untouched', () => {
    expect(resolveExecutable('npm.cmd', 'win32')).toBe('npm.cmd');
    expect(resolveExecutable('node.exe', 'win32')).toBe('node.exe');
  });

  it.runIf(process.platform === 'win32')('resolves a bare .cmd shim on Windows', () => {
    // The exact bug: spawn('npm') is ENOENT on Windows because Node does not
    // apply PATHEXT, and `shell: true` (the obvious fix) breaks cancellation.
    const resolved = resolveExecutable('npm', 'win32');
    expect(resolved).not.toBe('npm');
    expect(resolved.toLowerCase()).toMatch(/npm\.(cmd|exe|bat)$/);
  });

  it('returns the input unchanged when nothing matches, letting spawn report its own error', () => {
    expect(resolveExecutable('definitely-not-a-real-binary-xyz', 'win32')).toBe('definitely-not-a-real-binary-xyz');
  });
});

describe('run', () => {
  const cwd = path.resolve(__dirname, '..', '..');

  it('reports a clean exit', async () => {
    const outcome = await run({ command: process.execPath, args: ['-e', 'process.exit(0)'], cwd }).result;
    expect(outcome).toEqual({ kind: 'exited', exitCode: 0 });
    expect(isSuccess(outcome)).toBe(true);
  });

  it('reports a nonzero exit without throwing', async () => {
    const outcome = await run({ command: process.execPath, args: ['-e', 'process.exit(3)'], cwd }).result;
    expect(outcome).toEqual({ kind: 'exited', exitCode: 3 });
    expect(isSuccess(outcome)).toBe(false);
  });

  it('returns spawn-failed as an outcome rather than rejecting', async () => {
    // The stuck-stage bug: this used to reject, the caller's catch marked the
    // run failed, and nothing ever moved the in-flight stage off 'running'.
    const outcome = await run({ command: 'definitely-not-a-real-binary-xyz', args: [], cwd }).result;
    expect(outcome.kind).toBe('spawn-failed');
    expect(isSuccess(outcome)).toBe(false);
    expect(describeOutcome(outcome)).toMatch(/could not start process/i);
  });

  it('captures stdout', async () => {
    const chunks: string[] = [];
    const outcome = await run({
      command: process.execPath,
      args: ['-e', 'console.log("hello from child")'],
      cwd,
      onStdout: (c) => chunks.push(c.toString()),
    }).result;
    expect(isSuccess(outcome)).toBe(true);
    expect(chunks.join('')).toContain('hello from child');
  });

  it('captures stderr separately from stdout', async () => {
    const out: string[] = [];
    const err: string[] = [];
    await run({
      command: process.execPath,
      args: ['-e', 'console.error("to stderr")'],
      cwd,
      onStdout: (c) => out.push(c.toString()),
      onStderr: (c) => err.push(c.toString()),
    }).result;
    expect(err.join('')).toContain('to stderr');
    expect(out.join('')).not.toContain('to stderr');
  });

  it('cancels a long-running process', async () => {
    const managed = run({ command: process.execPath, args: ['-e', 'setTimeout(() => {}, 60000)'], cwd });
    // Let it actually spawn before killing it.
    await new Promise((r) => setTimeout(r, 200));
    managed.cancel();
    const outcome = await managed.result;
    expect(outcome.kind).toBe('cancelled');
    expect(describeOutcome(outcome)).toBe('cancelled');
  });

  it('times out a process that overruns', async () => {
    const outcome = await run({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 60000)'],
      cwd,
      timeoutMs: 300,
    }).result;
    expect(outcome.kind).toBe('timeout');
  });

  it('does not inherit the parent environment unless asked', async () => {
    // Env inheritance is opt-in because a child that inherits the hub's whole
    // environment is how secrets reach a crash log — a real failure mode
    // observed in this workspace with the Android emulator's crash reporter.
    process.env.MH_SUPERVISOR_LEAK_CHECK = 'should-not-be-visible';
    const chunks: string[] = [];
    await run({
      command: process.execPath,
      args: ['-e', 'console.log(String(process.env.MH_SUPERVISOR_LEAK_CHECK))'],
      cwd,
      env: { PATH: process.env.PATH },
      onStdout: (c) => chunks.push(c.toString()),
    }).result;
    delete process.env.MH_SUPERVISOR_LEAK_CHECK;
    expect(chunks.join('').trim()).toBe('undefined');
  });

  it.runIf(process.platform === 'win32')(
    'spawns a real .cmd shim without EINVAL — the exact bug found 2026-09-21',
    async () => {
      // Recent Node versions refuse to spawn a .bat/.cmd file directly at all
      // (`spawn EINVAL`), closing a command-injection class the old implicit
      // shell-out behavior allowed. A real `npm ci` install stage hit this in
      // production against this exact environment; `npm --version` reproduces
      // the identical failure in isolation. This is the regression guard.
      const outcome = await run({ command: 'npm', args: ['--version'], cwd }).result;
      expect(outcome.kind).toBe('exited');
      expect(isSuccess(outcome)).toBe(true);
    },
  );

  it.runIf(process.platform === 'win32')(
    'tree-kills a .cmd-spawned process through the shell hop shell:true now requires',
    async () => {
      // Regression guard for the concern that motivated avoiding shell:true in
      // the first place: on Windows, taskkill /T kills by PID tree regardless
      // of an intermediate cmd.exe hop, so a cancel must still take down the
      // real grandchild (cmd.exe -> the .cmd file -> node), not just the shell.
      const cmdPath = path.join(os.tmpdir(), `mh-supervisor-test-${process.pid}.cmd`);
      fs.writeFileSync(cmdPath, `@echo off\r\n"${process.execPath}" -e "setTimeout(() => {}, 60000)"\r\n`);
      try {
        const managed = run({ command: cmdPath, args: [], cwd });
        await new Promise((r) => setTimeout(r, 500)); // let the real grandchild actually start
        managed.cancel();
        const outcome = await managed.result;
        expect(outcome.kind).toBe('cancelled');
      } finally {
        fs.rmSync(cmdPath, { force: true });
      }
    },
  );

  it('settles exactly once even if cancel is called after exit', async () => {
    const managed = run({ command: process.execPath, args: ['-e', 'process.exit(0)'], cwd });
    const outcome: RunOutcome = await managed.result;
    managed.cancel(); // must not change the already-settled result or throw
    expect(await managed.result).toEqual(outcome);
  });
});
