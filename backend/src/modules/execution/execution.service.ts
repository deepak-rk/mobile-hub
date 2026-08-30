import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Types } from 'mongoose';
import * as supervisor from '../../common/process-supervisor';
import { RunOutcome, describeOutcome, isSuccess, ManagedProcess } from '../../common/process-supervisor';
import { env } from '../../config/env';
import { EffectiveConfig, PLATFORM_DEFAULTS } from '../../config/org-config.schema';
import { acquireLock, releaseLock } from '../devices/devices.service';
import { ExecutionRun, IExecutionRun, RunStatus, StageName, FailureKind } from './execution-run.model';
import { publishExecutionEvent } from './execution.events';

export class DeviceLockedError extends Error {
  constructor(deviceUdid: string) {
    super(`Device ${deviceUdid} is already locked`);
    this.name = 'DeviceLockedError';
  }
}

export class RunNotCancellableError extends Error {
  constructor(status: string) {
    super(`Run is already ${status}`);
    this.name = 'RunNotCancellableError';
  }
}

export interface RunCommand {
  command: string;
  args: string[];
}

export interface TriggerExecutionInput {
  machineId: string;
  deviceUdid: string;
  buildId?: string;
  project: string;
  branch: string;
  suite: string;
  triggeredBy: string;
  /** Runs before the test command (e.g. dependency install). Skipped if omitted. */
  setup?: RunCommand;
  run: RunCommand;
}

// Keyed by run id — lets cancel() find the live process, and lets a run's
// own orchestration always target "whatever's running right now" across its
// (up to) two spawned commands (setup, then execute).
const runningProcesses = new Map<string, ManagedProcess>();
const cancelledRuns = new Set<string>();

/**
 * "pulling"/"restoring_cache" stay the honest not-implemented stub
 * (root CLAUDE.md / docs/architecture-blueprint.md) for any project whose
 * `automation.repoUrl` isn't configured — building a real clone/cache step
 * with nowhere to point it would mean guessing. Once an org sets
 * `automation.repoUrl` (org-config.schema.ts), both stages run for real —
 * see the `automation.repoUrl` branch in `runExecution` below.
 *
 * The stub carries `status: 'skipped'` *and* an explicit `error` message —
 * not `status: 'skipped'` alone, the way `installing` legitimately is when a
 * caller simply didn't supply a `setup` command. Those are different claims:
 * "this step wasn't needed" versus "this step doesn't exist yet." Collapsing
 * them into the same bare 'skipped' would let a caller believe a repo was
 * pulled when nothing happened — the exact trap the build providers below
 * already avoid by rejecting with a clear message instead of a silent no-op.
 */
const NOT_IMPLEMENTED_STAGE_ERROR =
  'Not implemented: no automation.repoUrl is configured for this project (org-config.schema.ts). ' +
  'This did not run — it is not that nothing was needed.';
export async function triggerExecutionRun(
  input: TriggerExecutionInput,
  automation: EffectiveConfig['automation'] = PLATFORM_DEFAULTS.automation,
): Promise<IExecutionRun> {
  const runId = new Types.ObjectId();
  const workspacePath = path.join(env.EXECUTIONS_DIR, runId.toString());
  // The log lives outside the workspace so cleaning the workspace up doesn't
  // destroy the run's own history.
  const artifactsPath = path.join(env.EXECUTION_ARTIFACTS_DIR, runId.toString());
  const logPath = path.join(artifactsPath, 'run.log');
  const pullsRealRepo = Boolean(automation.repoUrl);

  const run = await ExecutionRun.create({
    _id: runId,
    machineId: input.machineId,
    deviceUdid: input.deviceUdid,
    buildId: input.buildId ?? null,
    project: input.project,
    branch: input.branch,
    suite: input.suite,
    triggeredBy: input.triggeredBy,
    status: 'queued',
    stages: [
      pullsRealRepo
        ? { name: 'pulling', status: 'pending' }
        : { name: 'pulling', status: 'skipped', error: NOT_IMPLEMENTED_STAGE_ERROR },
      pullsRealRepo
        ? { name: 'restoring_cache', status: 'pending' }
        : { name: 'restoring_cache', status: 'skipped', error: NOT_IMPLEMENTED_STAGE_ERROR },
      { name: 'installing', status: input.setup ? 'pending' : 'skipped' },
      { name: 'execute', status: 'pending' },
    ],
    workspacePath,
    artifactsPath,
    logPath,
  });

  const locked = await acquireLock(input.deviceUdid, input.triggeredBy, runId.toString(), `execution:${runId.toString()}`);
  if (!locked) {
    run.status = 'failed';
    // Nothing ran: the device was already busy. Recorded as a precondition
    // failure so it is excluded from pass rate — this run says nothing at all
    // about the application under test.
    run.failureKind = 'precondition';
    run.endedAt = new Date();
    await run.save();
    throw new DeviceLockedError(input.deviceUdid);
  }

  // Orchestration runs in the background — a real run can take minutes, so
  // the trigger endpoint returns immediately (backend/CLAUDE.md: prefer
  // WS-pushed transitions over blocking for this pipeline). The caller
  // polls GET /:id or watches GET /:id/stream.
  void runExecution(run, input, automation).catch((err: unknown) => {
    // runExecution handles its own errors internally (see its try/catch) —
    // this is a last-resort net so a bug there can't become an unhandled rejection.
    console.error(`Unhandled error running execution ${runId.toString()}:`, err);
  });

  return run;
}

/**
 * Marks a run failed *and* records why it failed, which are different facts.
 *
 * Without this split every failure looked identical to analytics, so a device
 * that happened to be locked — a run that never started, never touched the
 * app, and says nothing about its quality — dragged the suite's pass rate down
 * exactly as hard as a genuine test failure. See analytics.service.ts, which
 * now computes pass rate over test-attributable runs only.
 */
async function failRun(run: IExecutionRun, kind: FailureKind): Promise<void> {
  run.failureKind = kind;
  await setStatus(run, 'failed');
}

async function setStatus(run: IExecutionRun, status: RunStatus): Promise<void> {
  run.status = status;
  await run.save();
  publishExecutionEvent(run.id as string, { type: 'status', status });
}

async function setStage(
  run: IExecutionRun,
  name: StageName,
  status: 'running' | 'done' | 'error',
  error?: string,
): Promise<void> {
  const stage = run.stages.find((s) => s.name === name);
  if (!stage) return;
  if (status === 'running') stage.startedAt = new Date();
  if (status === 'done' || status === 'error') stage.endedAt = new Date();
  stage.status = status;
  if (error) stage.error = error;
  await run.save();
  publishExecutionEvent(run.id as string, { type: 'stage', stage: name, status, error });
}

/**
 * Runs one command through the shared supervisor and returns a normalized
 * outcome — never throws for a process-level failure, so every caller can
 * always record a stage result. See common/process-supervisor.ts for why.
 */
async function runCommand(
  cmd: RunCommand,
  cwd: string,
  logStream: fs.WriteStream,
  runId: string,
): Promise<RunOutcome> {
  const onChunk = (chunk: Buffer): void => {
    logStream.write(chunk);
    publishExecutionEvent(runId, { type: 'log', line: chunk.toString() });
  };

  const managed = supervisor.run({
    command: cmd.command,
    args: cmd.args,
    cwd,
    onStdout: onChunk,
    onStderr: onChunk,
  });
  runningProcesses.set(runId, managed);

  return managed.result;
}

/** package-lock.json when present (the actually-locked tree), else package.json, else no cache is possible. */
function findCacheableManifest(repoDir: string): string | null {
  const lockfile = path.join(repoDir, 'package-lock.json');
  if (fs.existsSync(lockfile)) return lockfile;
  const manifest = path.join(repoDir, 'package.json');
  return fs.existsSync(manifest) ? manifest : null;
}

/**
 * Thin, honest node_modules cache keyed by a hash of the repo's lockfile (or
 * package.json if no lockfile exists). A hit copies straight into
 * `repoDir/node_modules`; a miss is NOT an error — it is the legitimate
 * first-run state, logged plainly rather than silently claimed as a hit.
 * `saveCacheIfMissing` populates the cache after a successful `setup` so the
 * *next* run with the same lockfile hash gets a real hit.
 */
async function restoreCache(
  run: IExecutionRun,
  repoDir: string,
  logStream: fs.WriteStream,
): Promise<{ cacheDir: string | null }> {
  const manifest = findCacheableManifest(repoDir);
  const cacheKey = manifest ? crypto.createHash('sha256').update(fs.readFileSync(manifest)).digest('hex') : null;
  run.cacheKey = cacheKey;

  if (!cacheKey) {
    const line = 'restoring_cache: no package.json/package-lock.json found — nothing to key a cache on\n';
    logStream.write(line);
    publishExecutionEvent(run.id as string, { type: 'log', line });
    return { cacheDir: null };
  }

  const cacheDir = path.join(env.EXECUTIONS_DIR, '.cache', cacheKey);
  const hit = fs.existsSync(cacheDir);
  const line = hit
    ? `restoring_cache: cache hit (${cacheKey})\n`
    : `restoring_cache: no cache yet for ${cacheKey} — will populate after install\n`;
  logStream.write(line);
  publishExecutionEvent(run.id as string, { type: 'log', line });

  if (hit) await fs.promises.cp(cacheDir, path.join(repoDir, 'node_modules'), { recursive: true });
  return { cacheDir };
}

async function saveCacheIfMissing(repoDir: string, cacheDir: string | null): Promise<void> {
  if (!cacheDir || fs.existsSync(cacheDir)) return;
  const nodeModules = path.join(repoDir, 'node_modules');
  if (!fs.existsSync(nodeModules)) return;
  await fs.promises.mkdir(path.dirname(cacheDir), { recursive: true });
  await fs.promises.cp(nodeModules, cacheDir, { recursive: true });
}

async function runExecution(
  run: IExecutionRun,
  input: TriggerExecutionInput,
  automation: EffectiveConfig['automation'],
): Promise<void> {
  const runId = run.id as string;
  fs.mkdirSync(run.workspacePath, { recursive: true });
  fs.mkdirSync(path.dirname(run.logPath), { recursive: true });
  const logStream = fs.createWriteStream(run.logPath, { flags: 'a' });
  // Commands run in the workspace root unless a real repo gets cloned into
  // it below, in which case they move to run inside the checkout instead.
  let cwd = run.workspacePath;
  let cacheDir: string | null = null;

  try {
    await setStatus(run, 'preparing');
    run.startedAt = new Date();
    await run.save();

    // Every stage funnels through this so a cancel, a spawn failure, a
    // timeout and a nonzero exit all reach *both* the stage record and the run
    // status. The previous code updated the stage only on the nonzero-exit
    // path, which is how a run could read "failed" with a stage stuck on
    // "running" forever (docs/LESSONS.md).
    const settleStage = async (stage: StageName, outcome: RunOutcome, kindOnFailure: FailureKind): Promise<boolean> => {
      if (isSuccess(outcome)) {
        await setStage(run, stage, 'done');
        return true;
      }
      if (outcome.kind === 'cancelled' || cancelledRuns.has(runId)) {
        await setStage(run, stage, 'error', 'cancelled');
        await setStatus(run, 'cancelled');
        return false;
      }
      // A spawn failure or timeout is never the application's fault, whichever
      // stage it happened in — it is infrastructure, and must not be counted
      // against a suite's pass rate.
      const kind = outcome.kind === 'spawn-failed' || outcome.kind === 'timeout' ? 'infra' : kindOnFailure;
      await setStage(run, stage, 'error', describeOutcome(outcome));
      await failRun(run, kind);
      return false;
    };

    if (automation.repoUrl && !cancelledRuns.has(runId)) {
      const repoDir = path.join(run.workspacePath, 'repo');
      await setStage(run, 'pulling', 'running');
      const cloneOutcome = await runCommand(
        { command: 'git', args: ['clone', '--branch', input.branch, '--single-branch', automation.repoUrl, repoDir] },
        run.workspacePath,
        logStream,
        runId,
      );
      // Cloning is the hub's own plumbing — a failure here says nothing about
      // the app under test.
      if (!(await settleStage('pulling', cloneOutcome, 'infra'))) return;
      cwd = repoDir;

      await setStage(run, 'restoring_cache', 'running');
      ({ cacheDir } = await restoreCache(run, repoDir, logStream));
      await run.save(); // persist cacheKey set inside restoreCache
      await setStage(run, 'restoring_cache', 'done');
    }

    if (input.setup && !cancelledRuns.has(runId)) {
      await setStage(run, 'installing', 'running');
      const setupOutcome = await runCommand(input.setup, cwd, logStream, runId);
      // Dependency install failing is an environment problem, not a test result.
      if (!(await settleStage('installing', setupOutcome, 'infra'))) return;
      await saveCacheIfMissing(cwd, cacheDir);
    }

    if (cancelledRuns.has(runId)) {
      await setStage(run, 'execute', 'error', 'cancelled');
      await setStatus(run, 'cancelled');
      return;
    }

    await setStatus(run, 'running');
    await setStage(run, 'execute', 'running');
    const runOutcome = await runCommand(input.run, cwd, logStream, runId);

    // The only stage whose nonzero exit is a genuine *test* result.
    if (!(await settleStage('execute', runOutcome, 'test'))) return;
    await setStatus(run, 'passed');
  } catch (err) {
    publishExecutionEvent(runId, {
      type: 'log',
      line: `orchestration error: ${err instanceof Error ? err.message : String(err)}`,
    });
    // An exception in the orchestrator itself is infrastructure by definition.
    await failRun(run, 'infra');
  } finally {
    run.endedAt = new Date();
    await run.save();
    logStream.end();
    runningProcesses.delete(runId);
    cancelledRuns.delete(runId);
    // The workspace holds a full git clone plus a copied node_modules, so
    // leaving it behind grew the disk without bound. Safe to remove only
    // because run.log now lives under artifactsPath, outside this tree.
    // Best-effort: a locked file on Windows must not turn a passing run into
    // a failure at the very last step.
    try {
      fs.rmSync(run.workspacePath, { recursive: true, force: true });
    } catch (err) {
      publishExecutionEvent(runId, {
        type: 'log',
        line: `workspace cleanup failed (harmless, will be retried by a future sweep): ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      });
    }
    // isAdmin: true — a system-initiated release must succeed regardless of
    // ownership edge cases; this is cleanup, not a user-initiated unlock.
    await releaseLock(input.deviceUdid, input.triggeredBy, true);
  }
}

export async function cancelExecutionRun(id: string): Promise<IExecutionRun | null> {
  const run = await ExecutionRun.findById(id);
  if (!run) return null;
  if (!(['queued', 'preparing', 'running'] as RunStatus[]).includes(run.status)) {
    throw new RunNotCancellableError(run.status);
  }
  cancelledRuns.add(id);
  // Kills the whole process tree, not just the direct child — a test runner
  // is npm -> node -> wdio -> ..., and orphaning the tail leaves a process
  // still holding the device. See common/process-supervisor.ts.
  runningProcesses.get(id)?.cancel();
  return run;
}

export async function listExecutionRuns(filters: {
  project?: string;
  status?: string;
  deviceUdid?: string;
}): Promise<IExecutionRun[]> {
  const query: Record<string, unknown> = {};
  if (filters.project) query.project = filters.project;
  if (filters.status) query.status = filters.status;
  if (filters.deviceUdid) query.deviceUdid = filters.deviceUdid;
  return ExecutionRun.find(query).sort({ createdAt: -1 });
}

export async function getExecutionRun(id: string): Promise<IExecutionRun | null> {
  return ExecutionRun.findById(id);
}

/**
 * Cleans up any run left mid-flight by a backend crash/restart — the other
 * half of backend/CLAUDE.md's "guaranteed cleanup on success, failure, AND
 * on backend restart" gotcha (the finally-block above handles the first two).
 * Call once at server startup, before accepting traffic.
 */
export async function recoverOrphanedRuns(): Promise<number> {
  const orphaned = await ExecutionRun.find({ status: { $in: ['queued', 'preparing', 'running'] } });
  for (const run of orphaned) {
    const runningStage = run.stages.find((s) => s.status === 'running');
    if (runningStage) {
      runningStage.status = 'error';
      runningStage.error = 'Backend restarted mid-run';
      runningStage.endedAt = new Date();
    }
    run.status = 'failed';
    // A backend restart is infrastructure, not a test result.
    run.failureKind = 'infra';
    run.endedAt = new Date();
    await run.save();
    await releaseLock(run.deviceUdid, run.triggeredBy, true);
  }
  return orphaned.length;
}
