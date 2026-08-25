import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { Types } from 'mongoose';
import { env } from '../../config/env';
import { acquireLock, releaseLock } from '../devices/devices.service';
import { ExecutionRun, IExecutionRun, RunStatus, StageName } from './execution-run.model';
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
const runningProcesses = new Map<string, ChildProcess>();
const cancelledRuns = new Set<string>();

/**
 * Fetches, checks out, and stages the automation repo for a run ("pulling",
 * "restoring_cache" stages) are deliberately NOT implemented — root
 * CLAUDE.md / docs/architecture-blueprint.md don't yet specify where an
 * automation repo's source lives (git URL, branch-per-project convention,
 * etc.). Those two stages are marked 'skipped' until that's a real decision;
 * building them now would mean guessing. See docs/TODO.md.
 */
export async function triggerExecutionRun(input: TriggerExecutionInput): Promise<IExecutionRun> {
  const runId = new Types.ObjectId();
  const workspacePath = path.join(env.EXECUTIONS_DIR, runId.toString());
  const logPath = path.join(workspacePath, 'run.log');

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
      { name: 'pulling', status: 'skipped' },
      { name: 'restoring_cache', status: 'skipped' },
      { name: 'installing', status: input.setup ? 'pending' : 'skipped' },
      { name: 'execute', status: 'pending' },
    ],
    workspacePath,
    logPath,
  });

  const locked = await acquireLock(input.deviceUdid, input.triggeredBy, runId.toString(), `execution:${runId.toString()}`);
  if (!locked) {
    run.status = 'failed';
    run.endedAt = new Date();
    await run.save();
    throw new DeviceLockedError(input.deviceUdid);
  }

  // Orchestration runs in the background — a real run can take minutes, so
  // the trigger endpoint returns immediately (backend/CLAUDE.md: prefer
  // WS-pushed transitions over blocking for this pipeline). The caller
  // polls GET /:id or watches GET /:id/stream.
  void runExecution(run, input).catch((err: unknown) => {
    // runExecution handles its own errors internally (see its try/catch) —
    // this is a last-resort net so a bug there can't become an unhandled rejection.
    console.error(`Unhandled error running execution ${runId.toString()}:`, err);
  });

  return run;
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

function runCommand(cmd: RunCommand, cwd: string, logStream: fs.WriteStream, runId: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd.command, cmd.args, { cwd });
    runningProcesses.set(runId, child);

    child.stdout.on('data', (chunk: Buffer) => {
      logStream.write(chunk);
      publishExecutionEvent(runId, { type: 'log', line: chunk.toString() });
    });
    child.stderr.on('data', (chunk: Buffer) => {
      logStream.write(chunk);
      publishExecutionEvent(runId, { type: 'log', line: chunk.toString() });
    });
    child.on('error', (err) => reject(err));
    child.on('exit', (code) => resolve(code));
  });
}

async function runExecution(run: IExecutionRun, input: TriggerExecutionInput): Promise<void> {
  const runId = run.id as string;
  fs.mkdirSync(run.workspacePath, { recursive: true });
  const logStream = fs.createWriteStream(run.logPath, { flags: 'a' });

  try {
    await setStatus(run, 'preparing');
    run.startedAt = new Date();
    await run.save();

    if (input.setup && !cancelledRuns.has(runId)) {
      await setStage(run, 'installing', 'running');
      const exitCode = await runCommand(input.setup, run.workspacePath, logStream, runId);
      if (cancelledRuns.has(runId)) {
        await setStage(run, 'installing', 'error', 'cancelled');
        await setStatus(run, 'cancelled');
        return;
      }
      if (exitCode !== 0) {
        await setStage(run, 'installing', 'error', `exit code ${String(exitCode)}`);
        await setStatus(run, 'failed');
        return;
      }
      await setStage(run, 'installing', 'done');
    }

    if (cancelledRuns.has(runId)) {
      await setStage(run, 'execute', 'error', 'cancelled');
      await setStatus(run, 'cancelled');
      return;
    }

    await setStatus(run, 'running');
    await setStage(run, 'execute', 'running');
    const exitCode = await runCommand(input.run, run.workspacePath, logStream, runId);

    if (cancelledRuns.has(runId)) {
      await setStage(run, 'execute', 'error', 'cancelled');
      await setStatus(run, 'cancelled');
      return;
    }
    if (exitCode !== 0) {
      await setStage(run, 'execute', 'error', `exit code ${String(exitCode)}`);
      await setStatus(run, 'failed');
      return;
    }
    await setStage(run, 'execute', 'done');
    await setStatus(run, 'passed');
  } catch (err) {
    publishExecutionEvent(runId, {
      type: 'log',
      line: `orchestration error: ${err instanceof Error ? err.message : String(err)}`,
    });
    await setStatus(run, 'failed');
  } finally {
    run.endedAt = new Date();
    await run.save();
    logStream.end();
    runningProcesses.delete(runId);
    cancelledRuns.delete(runId);
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
  runningProcesses.get(id)?.kill('SIGTERM');
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
    run.endedAt = new Date();
    await run.save();
    await releaseLock(run.deviceUdid, run.triggeredBy, true);
  }
  return orphaned.length;
}
