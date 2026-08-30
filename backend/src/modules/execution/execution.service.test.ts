import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { ExecutionRun } from './execution-run.model';
import { env } from '../../config/env';
import { PLATFORM_DEFAULTS } from '../../config/org-config.schema';
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
let artifactsDir: string;
let origArtifactsDir: string;

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
    // Mirrors the real split: the log lives under the artifacts root, NOT
    // inside the workspace, which is deleted when the run ends.
    artifactsPath: path.join(artifactsDir, 'run-1'),
    logPath: path.join(artifactsDir, 'run-1', 'run.log'),
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
  // Deliberately a sibling of the workspace root, not a child — the whole
  // point of the split is that wiping one cannot touch the other.
  artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-exec-artifacts-'));
  origExecDir = env.EXECUTIONS_DIR;
  origArtifactsDir = env.EXECUTION_ARTIFACTS_DIR;
  env.EXECUTIONS_DIR = tmpDir;
  env.EXECUTION_ARTIFACTS_DIR = artifactsDir;
});

/**
 * The log write stream's fd can still be closing when cleanup runs (its
 * `.end()` in runExecution's finally block is async) — Windows won't remove a
 * directory while a file inside it has an open handle. `rmSync` has no retry
 * option, so retry rather than race it once.
 *
 * Now used for the artifacts root too, not just the workspace: that root holds
 * `run.log`, i.e. it is *more* exposed to this race than the workspace ever was.
 */
async function rmWithRetry(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (attempt === 4) throw err;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

afterEach(async () => {
  env.EXECUTIONS_DIR = origExecDir;
  env.EXECUTION_ARTIFACTS_DIR = origArtifactsDir;
  await rmWithRetry(artifactsDir);
  await rmWithRetry(tmpDir);
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

  it('marks pulling/restoring_cache as not-implemented, distinct from installing being genuinely skipped', async () => {
    // installing is 'skipped' with no error when the caller simply didn't
    // supply a setup command — that's a real, intentional skip. pulling and
    // restoring_cache are 'skipped' for every run because the feature does
    // not exist yet, which is a different claim and must not read the same
    // way, or a caller could believe a repo was pulled when nothing happened.
    const doc = fakeRunDoc();
    const create = vi.spyOn(ExecutionRun, 'create').mockResolvedValue(doc as never);
    vi.spyOn(devicesService, 'acquireLock').mockResolvedValue({} as never);
    const released = waitForReleaseLock();

    await triggerExecutionRun({ ...baseInput, run: { command: 'node', args: ['-e', 'process.exit(0)'] } });
    await released;

    const passedStages = (create.mock.calls[0][0] as { stages: { name: string; status: string; error?: string }[] })
      .stages;
    const pulling = passedStages.find((s) => s.name === 'pulling');
    const restoringCache = passedStages.find((s) => s.name === 'restoring_cache');
    const installing = passedStages.find((s) => s.name === 'installing');

    expect(pulling?.status).toBe('skipped');
    expect(pulling?.error).toMatch(/not implemented/i);
    expect(restoringCache?.status).toBe('skipped');
    expect(restoringCache?.error).toMatch(/not implemented/i);
    // No setup command was supplied in this input, so installing's skip is
    // the genuinely-optional kind — no error attached.
    expect(installing?.status).toBe('skipped');
    expect(installing?.error).toBeUndefined();
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

describe('pulling / restoring_cache with a real automation.repoUrl configured', () => {
  function initGitRepo(dir: string): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo-app' }));
    execSync('git init -q -b main', { cwd: dir });
    execSync('git config user.email test@example.com', { cwd: dir });
    execSync('git config user.name Test', { cwd: dir });
    execSync('git add -A', { cwd: dir });
    execSync('git commit -q -m init', { cwd: dir });
  }

  it('clones a real repo, then reuses the node_modules cache on a second run with the same lockfile hash', async () => {
    const repoSource = path.join(tmpDir, 'source-repo');
    initGitRepo(repoSource);
    const automation = { ...PLATFORM_DEFAULTS.automation, repoUrl: repoSource };

    // --- Run 1: no cache exists yet ---
    const doc1 = fakeRunDoc({ id: 'run-1', workspacePath: path.join(tmpDir, 'run-1'), artifactsPath: path.join(artifactsDir, 'run-1'), logPath: path.join(artifactsDir, 'run-1', 'run.log') });
    vi.spyOn(ExecutionRun, 'create').mockResolvedValueOnce(doc1 as never);
    vi.spyOn(devicesService, 'acquireLock').mockResolvedValue({} as never);
    let released = waitForReleaseLock();

    await triggerExecutionRun(
      {
        ...baseInput,
        // 'installing' stands in for a real `npm ci` here — it just drops a
        // marker file into node_modules so the cache-save path has something
        // real to persist, without this test depending on network access.
        setup: { command: 'node', args: ['-e', "require('fs').mkdirSync('node_modules'); require('fs').writeFileSync('node_modules/marker.txt', 'hit')"] },
        run: { command: 'node', args: ['-e', 'process.exit(0)'] },
      },
      automation,
    );
    await released;

    expect(doc1.status).toBe('passed');
    const pulling1 = (doc1.stages as { name: string; status: string }[]).find((s) => s.name === 'pulling');
    const cache1 = (doc1.stages as { name: string; status: string }[]).find((s) => s.name === 'restoring_cache');
    expect(pulling1?.status).toBe('done');
    expect(cache1?.status).toBe('done');
    expect(doc1.cacheKey).toMatch(/^[a-f0-9]{64}$/); // sha256 of package.json — a real hash was computed
    // The workspace is deleted when a run ends (it holds a full clone plus a
    // copied node_modules), so the clone is gone by now — but the *log* must
    // survive, because it lives under artifactsPath outside that tree. This
    // pair is the whole point of separating the two directories: before the
    // split, "clean up the workspace" and "serve a finished run's log" could
    // not both be true.
    expect(fs.existsSync(path.join(tmpDir, 'run-1', 'repo', 'package.json'))).toBe(false);
    expect(fs.existsSync(doc1.logPath as string)).toBe(true);
    // The clone really did happen — the cache it populated proves it, since a
    // cache entry can only exist if a real repo was checked out and installed.
    expect(fs.existsSync(path.join(tmpDir, '.cache', doc1.cacheKey as string, 'marker.txt'))).toBe(true);

    // --- Run 2: same repoUrl/branch => same lockfile hash => should hit the cache run 1 saved ---
    const doc2 = fakeRunDoc({ id: 'run-2', workspacePath: path.join(tmpDir, 'run-2'), artifactsPath: path.join(artifactsDir, 'run-2'), logPath: path.join(artifactsDir, 'run-2', 'run.log') });
    vi.spyOn(ExecutionRun, 'create').mockResolvedValueOnce(doc2 as never);
    released = waitForReleaseLock();

    await triggerExecutionRun(
      { ...baseInput, run: { command: 'node', args: ['-e', 'process.exit(0)'] } }, // no setup this time
      automation,
    );
    await released;

    expect(doc2.status).toBe('passed');
    // Restored from run 1's cache, not created by a setup step (none was
    // given). Asserted from the run's own durable log rather than the
    // workspace, which no longer exists by the time the run ends — and this
    // doubles as proof that the log genuinely survives workspace cleanup,
    // which is what makes serving a finished run's output possible at all.
    const run2Log = fs.readFileSync(doc2.logPath as string, 'utf8');
    expect(run2Log).toContain(`cache hit (${doc1.cacheKey as string})`);
  });

  it('leaves the not-implemented stub in place when automation.repoUrl is unset', async () => {
    const doc = fakeRunDoc();
    vi.spyOn(ExecutionRun, 'create').mockResolvedValue(doc as never);
    vi.spyOn(devicesService, 'acquireLock').mockResolvedValue({} as never);
    const released = waitForReleaseLock();

    // No second argument — matches every real call site before this feature existed.
    await triggerExecutionRun({ ...baseInput, run: { command: 'node', args: ['-e', 'process.exit(0)'] } });
    await released;

    expect(doc.status).toBe('passed');
    expect(fs.existsSync(path.join(tmpDir, 'run-1', 'repo'))).toBe(false);
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
