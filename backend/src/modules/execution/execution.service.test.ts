import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ExecutionRun } from './execution-run.model';
import { env } from '../../config/env';
import * as devicesService from '../devices/devices.service';
import { triggerExecutionRun, cancelExecutionRun, recoverOrphanedRuns, DeviceLockedError } from './execution.service';

/**
 * The one property this module exists for: the device lock is released in
 * every terminal path — success, failure, AND cancellation (backend/CLAUDE.md's
 * process-cleanup gotcha). Orchestration runs in the background
 * (`void runExecution(...)`), so each test waits on `releaseLock` actually
 * being called rather than a fixed delay — deterministic regardless of how
 * fast the spawned process happens to exit.
 *
 * Real `node -e` child processes are used (matching the sibling E2E suite's
 * proven pattern) rather than mocking `child_process.spawn` — the thing being
 * tested is what happens around a real process's exit, so faking the process
 * would test nothing. No database is used: Mongoose calls are stubbed.
 */
let tmpDir: string;
let origExecDir: string;

function fakeRunDoc(overrides: Partial<Record<string, unknown>> = {}) {
  const doc: Record<string, unknown> = {
    id: 'run-1',
    status: 'queued',
    stages: [
      { name: 'pulling', status: 'skipped' },
      { name: 'restoring_cache', status: 'skipped' },
      { name: 'installing', status: 'skipped' },
      { name: 'execute', status: 'pending' },
    ],
    workspacePath: path.join(tmpDir, 'run-1'),
    logPath: path.join(tmpDir, 'run-1', 'run.log'),
    deviceUdid: 'd1',
    triggeredBy: 'user-1',
    ...overrides,
  };
  (doc as { save: () => Promise<void> }).save = vi.fn().mockResolvedValue(undefined);
  return doc;
}

function waitForReleaseLock() {
  let released!: () => void;
  const promise = new Promise<void>((resolve) => {
    released = resolve;
  });
  vi.spyOn(devicesService, 'releaseLock').mockImplementation(async () => {
    released();
    return null;
  });
  return promise;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-exec-test-'));
  origExecDir = env.EXECUTIONS_DIR;
  env.EXECUTIONS_DIR = tmpDir;
});

afterEach(async () => {
  env.EXECUTIONS_DIR = origExecDir;
  // The log write stream's fd can still be closing when this runs (its
  // .end() in runExecution's finally block is async) — Windows won't let a
  // directory be removed while a file inside it has an open handle. rmSync
  // itself has no retry option, so retry the call a few times rather than
  // race it once.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      break;
    } catch (err) {
      if (attempt === 4) throw err;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  vi.restoreAllMocks();
});

const baseInput = {
  machineId: 'host-1',
  deviceUdid: 'd1',
  project: 'p',
  branch: 'main',
  suite: 'smoke',
  triggeredBy: 'user-1',
};

describe('triggerExecutionRun', () => {
  it('throws DeviceLockedError and never starts orchestration if the lock is unavailable', async () => {
    const doc = fakeRunDoc();
    vi.spyOn(ExecutionRun, 'create').mockResolvedValue(doc as never);
    vi.spyOn(devicesService, 'acquireLock').mockResolvedValue(null);
    const releaseLock = vi.spyOn(devicesService, 'releaseLock');

    await expect(triggerExecutionRun({ ...baseInput, run: { command: 'node', args: ['-e', 'process.exit(0)'] } })).rejects.toThrow(
      DeviceLockedError,
    );

    expect(doc.status).toBe('failed');
    expect(releaseLock).not.toHaveBeenCalled(); // never acquired, so nothing to release
  });

  it('releases the lock after a passing run', async () => {
    const doc = fakeRunDoc();
    vi.spyOn(ExecutionRun, 'create').mockResolvedValue(doc as never);
    vi.spyOn(devicesService, 'acquireLock').mockResolvedValue({} as never);
    const released = waitForReleaseLock();

    await triggerExecutionRun({ ...baseInput, run: { command: 'node', args: ['-e', 'process.exit(0)'] } });
    await released;

    expect(doc.status).toBe('passed');
    expect(doc.endedAt).toBeInstanceOf(Date);
  });

  it('releases the lock after a failing run (nonzero exit)', async () => {
    const doc = fakeRunDoc();
    vi.spyOn(ExecutionRun, 'create').mockResolvedValue(doc as never);
    vi.spyOn(devicesService, 'acquireLock').mockResolvedValue({} as never);
    const released = waitForReleaseLock();

    await triggerExecutionRun({ ...baseInput, run: { command: 'node', args: ['-e', 'process.exit(1)'] } });
    await released;

    expect(doc.status).toBe('failed');
    const execStage = (doc.stages as { name: string; status: string; error?: string }[]).find(
      (s) => s.name === 'execute',
    );
    expect(execStage?.status).toBe('error');
    expect(execStage?.error).toContain('1');
  });

  it('releases the lock when a run is cancelled mid-flight', async () => {
    const doc = fakeRunDoc();
    vi.spyOn(ExecutionRun, 'create').mockResolvedValue(doc as never);
    vi.spyOn(devicesService, 'acquireLock').mockResolvedValue({} as never);
    vi.spyOn(ExecutionRun, 'findById').mockResolvedValue(doc as never);
    const released = waitForReleaseLock();

    await triggerExecutionRun({
      ...baseInput,
      run: { command: 'node', args: ['-e', 'setTimeout(() => process.exit(0), 5000)'] },
    });
    // Give the child process a moment to actually spawn before killing it.
    await new Promise((r) => setTimeout(r, 150));
    doc.status = 'running';
    await cancelExecutionRun('run-1');
    await released;

    expect(doc.status).toBe('cancelled');
  });
});

describe('recoverOrphanedRuns', () => {
  it('marks a mid-flight run failed, its running stage errored, and releases the lock', async () => {
    const orphan = fakeRunDoc({
      status: 'running',
      stages: [
        { name: 'pulling', status: 'skipped' },
        { name: 'restoring_cache', status: 'skipped' },
        { name: 'installing', status: 'done' },
        { name: 'execute', status: 'running' },
      ],
    });
    vi.spyOn(ExecutionRun, 'find').mockResolvedValue([orphan] as never);
    const releaseLock = vi.spyOn(devicesService, 'releaseLock').mockResolvedValue(null);

    const count = await recoverOrphanedRuns();

    expect(count).toBe(1);
    expect(orphan.status).toBe('failed');
    const execStage = (orphan.stages as { name: string; status: string; error?: string }[]).find(
      (s) => s.name === 'execute',
    );
    expect(execStage?.status).toBe('error');
    expect(execStage?.error).toBe('Backend restarted mid-run');
    expect(releaseLock).toHaveBeenCalledWith('d1', 'user-1', true);
  });

  it('does nothing when no run is mid-flight', async () => {
    vi.spyOn(ExecutionRun, 'find').mockResolvedValue([] as never);
    const releaseLock = vi.spyOn(devicesService, 'releaseLock');

    expect(await recoverOrphanedRuns()).toBe(0);
    expect(releaseLock).not.toHaveBeenCalled();
  });
});

describe('cancelExecutionRun', () => {
  it('rejects cancelling a run that is already terminal', async () => {
    vi.spyOn(ExecutionRun, 'findById').mockResolvedValue(fakeRunDoc({ status: 'passed' }) as never);

    await expect(cancelExecutionRun('run-1')).rejects.toThrow(/already passed/);
  });

  it('returns null for an unknown run id', async () => {
    vi.spyOn(ExecutionRun, 'findById').mockResolvedValue(null as never);

    expect(await cancelExecutionRun('nope')).toBeNull();
  });
});
