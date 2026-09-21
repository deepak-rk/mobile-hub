import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { Types } from 'mongoose';
import { ExecutionRun } from './execution-run.model';
import { env } from '../../config/env';
import { PLATFORM_DEFAULTS } from '../../config/org-config.schema';
import * as devicesService from '../devices/devices.service';
import {
  triggerExecutionRun,
  cancelExecutionRun,
  recoverOrphanedRuns,
  sweepFinishedWorkspaces,
  computeCacheKey,
  getActiveRunCountForMachine,
  getQueuePosition,
  dispatchQueuedRuns,
} from './execution.service';

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

  // triggerExecutionRun reads the device to snapshot its platform/model onto
  // the run. Stubbed for every test, not just the ones that care: an unmocked
  // Mongoose query against no database never settles, so leaving it real turns
  // an unrelated assertion into a 5s timeout with nothing to diagnose. Same
  // trap as builds.service.test.ts's claim upsert.
  vi.spyOn(devicesService, 'getDevice').mockResolvedValue({
    udid: 'd1',
    platform: 'android',
    model: 'Pixel 7',
    name: 'Lab phone',
  } as never);
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
  it('leaves the run queued and never starts orchestration if the lock is unavailable', async () => {
    const doc = fakeRunDoc();
    vi.spyOn(ExecutionRun, 'create').mockResolvedValue(doc as never);
    vi.spyOn(devicesService, 'acquireLock').mockResolvedValue(null);
    const releaseLock = vi.spyOn(devicesService, 'releaseLock');

    const run = await triggerExecutionRun({ ...baseInput, run: { command: 'node', args: ['-e', 'process.exit(0)'] } });

    expect(run.status).toBe('queued');
    expect(releaseLock).not.toHaveBeenCalled(); // never acquired, so nothing to release
  });

  it('persists the resolved setup/run commands on the run, for dispatchQueuedRuns to use later', async () => {
    const doc = fakeRunDoc();
    const create = vi.spyOn(ExecutionRun, 'create').mockResolvedValue(doc as never);
    vi.spyOn(devicesService, 'acquireLock').mockResolvedValue(null);

    await triggerExecutionRun({
      ...baseInput,
      setup: { command: 'npm', args: ['ci'] },
      run: { command: 'npx', args: ['wdio'] },
    });

    const passed = create.mock.calls[0][0] as { commands: { setup: unknown; run: unknown } };
    expect(passed.commands).toEqual({ setup: { command: 'npm', args: ['ci'] }, run: { command: 'npx', args: ['wdio'] } });
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

/**
 * Direct unit tests for the formula itself — the integration test above only
 * ever asserts "a sha256-shaped string came out", never that the *inputs*
 * that are supposed to matter actually change it. That gap is exactly how
 * the previous lockfile-only formula (a confirmed collision source per
 * `docs/modules/execution.md`) went unnoticed: a lockfile regenerated with
 * identical content after a meaningful `package.json` change produced the
 * same key both before and after, and nothing here would have caught it.
 */
describe('computeCacheKey', () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = path.join(tmpDir, 'repo');
    fs.mkdirSync(repoDir, { recursive: true });
  });

  function writeManifest(content: string) {
    fs.writeFileSync(path.join(repoDir, 'package.json'), content);
  }

  it('returns null when the repo has no package.json', () => {
    expect(computeCacheKey(repoDir)).toBeNull();
  });

  it('returns a stable sha256 hex digest for the same inputs', () => {
    writeManifest('{"name":"demo"}');
    const key1 = computeCacheKey(repoDir, 'linux', 'v20.0.0');
    const key2 = computeCacheKey(repoDir, 'linux', 'v20.0.0');
    expect(key1).toMatch(/^[a-f0-9]{64}$/);
    expect(key1).toBe(key2);
  });

  it('changes when package.json changes, even with an identical lockfile — the exact regression this formula exists to fix', () => {
    writeManifest('{"name":"demo","scripts":{"build":"a"}}');
    fs.writeFileSync(path.join(repoDir, 'package-lock.json'), '{"lockfileVersion":3}');
    const before = computeCacheKey(repoDir, 'linux', 'v20.0.0');

    // Lockfile untouched, only package.json changes (a moved dependency, a
    // changed script) — the old lockfile-only formula would have kept
    // serving the stale cache here.
    writeManifest('{"name":"demo","scripts":{"build":"b"}}');
    const after = computeCacheKey(repoDir, 'linux', 'v20.0.0');

    expect(after).not.toBe(before);
  });

  it('changes when the platform changes', () => {
    writeManifest('{"name":"demo"}');
    const linux = computeCacheKey(repoDir, 'linux', 'v20.0.0');
    const win32 = computeCacheKey(repoDir, 'win32', 'v20.0.0');
    expect(linux).not.toBe(win32);
  });

  it('changes when the Node version changes — a native addon compiled for one Node ABI is not safe to restore under another', () => {
    writeManifest('{"name":"demo"}');
    const v20 = computeCacheKey(repoDir, 'linux', 'v20.0.0');
    const v22 = computeCacheKey(repoDir, 'linux', 'v22.0.0');
    expect(v20).not.toBe(v22);
  });

  it('changes when a lockfile is added, and again if the lockfile name changes for identical content', () => {
    writeManifest('{"name":"demo"}');
    const noLockfile = computeCacheKey(repoDir, 'linux', 'v20.0.0');

    fs.writeFileSync(path.join(repoDir, 'package-lock.json'), 'SAME CONTENT');
    const npmLock = computeCacheKey(repoDir, 'linux', 'v20.0.0');
    expect(npmLock).not.toBe(noLockfile);

    // Same content, different package manager's lockfile name — must not
    // collide, per the doc comment's explicit "switching package managers"
    // guard.
    fs.rmSync(path.join(repoDir, 'package-lock.json'));
    fs.writeFileSync(path.join(repoDir, 'yarn.lock'), 'SAME CONTENT');
    const yarnLock = computeCacheKey(repoDir, 'linux', 'v20.0.0');
    expect(yarnLock).not.toBe(npmLock);
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

  it('cancels a queued run directly — no process to kill, no lock ever held', async () => {
    const doc = fakeRunDoc({ status: 'queued' });
    vi.spyOn(ExecutionRun, 'findById').mockResolvedValue(doc as never);

    const run = await cancelExecutionRun('run-1');

    expect(run?.status).toBe('cancelled');
    expect(doc.endedAt).toBeInstanceOf(Date);
    expect(doc.save).toHaveBeenCalled();
  });
});

describe('getQueuePosition', () => {
  it('returns null for a run that is not queued', async () => {
    expect(await getQueuePosition(fakeRunDoc({ status: 'running' }) as never)).toBeNull();
  });

  it('returns 1-based position among runs queued for the same device, oldest first', async () => {
    const countDocuments = vi.spyOn(ExecutionRun, 'countDocuments').mockResolvedValue(2 as never);
    const createdAt = new Date('2026-01-01T00:00:00Z');

    const position = await getQueuePosition(fakeRunDoc({ status: 'queued', deviceUdid: 'd1', createdAt }) as never);

    expect(position).toBe(3); // 2 ahead + this one
    expect(countDocuments).toHaveBeenCalledWith({ deviceUdid: 'd1', status: 'queued', createdAt: { $lt: createdAt } });
  });
});

describe('dispatchQueuedRuns', () => {
  const config = { projects: {}, automation: PLATFORM_DEFAULTS.automation, appium: PLATFORM_DEFAULTS.appium } as never;

  it('starts the oldest queued run for a device once its lock is available', async () => {
    const queued = fakeRunDoc({ status: 'queued', deviceUdid: 'd1', commands: { setup: null, run: { command: 'node', args: ['-e', 'process.exit(0)'] } } });
    vi.spyOn(ExecutionRun, 'find').mockReturnValue({ sort: () => Promise.resolve([queued]) } as never);
    vi.spyOn(devicesService, 'acquireLock').mockResolvedValue({} as never);
    vi.spyOn(ExecutionRun, 'findById').mockResolvedValue(queued as never);
    const released = waitForReleaseLock();

    const started = await dispatchQueuedRuns(config);
    await released;

    expect(started).toBe(1);
  });

  it('does not attempt a second queued run for a device already attempted this pass', async () => {
    const first = fakeRunDoc({ id: 'run-1', status: 'queued', deviceUdid: 'd1' });
    const second = fakeRunDoc({ id: 'run-2', status: 'queued', deviceUdid: 'd1' });
    vi.spyOn(ExecutionRun, 'find').mockReturnValue({ sort: () => Promise.resolve([first, second]) } as never);
    const acquireLock = vi.spyOn(devicesService, 'acquireLock').mockResolvedValue(null); // device still busy

    await dispatchQueuedRuns(config);

    expect(acquireLock).toHaveBeenCalledTimes(1); // never tried `second` — same device, already attempted
  });

  it('releases the lock and skips a run that was cancelled between listing and winning the lock', async () => {
    const queued = fakeRunDoc({ status: 'queued', deviceUdid: 'd1' });
    vi.spyOn(ExecutionRun, 'find').mockReturnValue({ sort: () => Promise.resolve([queued]) } as never);
    vi.spyOn(devicesService, 'acquireLock').mockResolvedValue({} as never);
    // Re-read (inside dispatchQueuedRuns, after winning the lock) sees it was cancelled in the meantime.
    vi.spyOn(ExecutionRun, 'findById').mockResolvedValue(fakeRunDoc({ status: 'cancelled' }) as never);
    const releaseLock = vi.spyOn(devicesService, 'releaseLock').mockResolvedValue(null);

    const started = await dispatchQueuedRuns(config);

    expect(started).toBe(0);
    expect(releaseLock).toHaveBeenCalled();
  });
});

describe('getActiveRunCountForMachine', () => {
  it('counts queued/preparing/running runs scoped to the requested machine', async () => {
    const countDocuments = vi.spyOn(ExecutionRun, 'countDocuments').mockResolvedValue(4 as never);

    const count = await getActiveRunCountForMachine('host-1');

    expect(count).toBe(4);
    expect(countDocuments).toHaveBeenCalledWith({
      machineId: 'host-1',
      status: { $in: ['queued', 'preparing', 'running'] },
    });
  });
});

describe('sweepFinishedWorkspaces', () => {
  const HOUR = 60 * 60 * 1000;

  function makeWorkspace(id: string, ageMs = 0) {
    const dir = path.join(tmpDir, id);
    fs.mkdirSync(path.join(dir, 'repo'), { recursive: true });
    if (ageMs > 0) {
      const when = new Date(Date.now() - ageMs);
      fs.utimesSync(dir, when, when);
    }
    return dir;
  }

  it('removes finished runs, keeps in-flight ones, and never touches the shared cache', async () => {
    const finished = new Types.ObjectId().toString();
    const running = new Types.ObjectId().toString();
    makeWorkspace(finished);
    makeWorkspace(running);
    // The node_modules cache lives alongside workspaces and must survive —
    // it is the thing that makes a second run fast.
    const cache = path.join(tmpDir, '.cache');
    fs.mkdirSync(cache, { recursive: true });

    vi.spyOn(ExecutionRun, 'find').mockReturnValue({
      select: vi.fn().mockResolvedValue([
        { id: finished, status: 'passed' },
        { id: running, status: 'running' },
      ]),
    } as never);

    const removed = await sweepFinishedWorkspaces();

    expect(removed).toBe(1);
    expect(fs.existsSync(path.join(tmpDir, finished))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, running))).toBe(true);
    expect(fs.existsSync(cache)).toBe(true);
  });

  it('reclaims workspaces whose run record no longer exists, but only once they are old', async () => {
    // The real cause of the backlog on this machine: the database was reset
    // while the disk was not, leaving workspaces nothing will ever claim.
    const oldOrphan = new Types.ObjectId().toString();
    const freshOrphan = new Types.ObjectId().toString();
    makeWorkspace(oldOrphan, 2 * HOUR);
    makeWorkspace(freshOrphan);

    vi.spyOn(ExecutionRun, 'find').mockReturnValue({ select: vi.fn().mockResolvedValue([]) } as never);

    const removed = await sweepFinishedWorkspaces();

    expect(removed).toBe(1);
    expect(fs.existsSync(path.join(tmpDir, oldOrphan))).toBe(false);
    // A run creates its directory around the same moment as its record, so a
    // recent recordless workspace may be one starting right now.
    expect(fs.existsSync(path.join(tmpDir, freshOrphan))).toBe(true);
  });
});
