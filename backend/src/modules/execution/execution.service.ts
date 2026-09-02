import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Types } from 'mongoose';
import * as supervisor from '../../common/process-supervisor';
import { RunOutcome, describeOutcome, isSuccess, ManagedProcess } from '../../common/process-supervisor';
import { env } from '../../config/env';
import { EffectiveConfig, PLATFORM_DEFAULTS } from '../../config/org-config.schema';
import { acquireLock, getDevice, releaseLock } from '../devices/devices.service';
import { getBuild } from '../builds/builds.service';
import { assertDriverInstalled, ensureAppiumServer } from './appium.service';
import { buildRunEnvironment, createRedactor } from './run-environment';
import { classifySuite } from './automation-commands';
import { summarizeRunResults, ALLURE_RESULTS_DIRNAME } from './allure-summary';
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
 * How long a workspace with no run record must sit untouched before the sweep
 * treats it as abandoned. Far longer than the gap between a run creating its
 * directory and its record, so a starting run is never mistaken for junk.
 */
const ORPHAN_WORKSPACE_GRACE_MS = 60 * 60 * 1000;

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
  appiumConfig?: EffectiveConfig['appium'],
): Promise<IExecutionRun> {
  const runId = new Types.ObjectId();
  const workspacePath = path.join(env.EXECUTIONS_DIR, runId.toString());
  // The log lives outside the workspace so cleaning the workspace up doesn't
  // destroy the run's own history.
  const artifactsPath = path.join(env.EXECUTION_ARTIFACTS_DIR, runId.toString());
  const logPath = path.join(artifactsPath, 'run.log');
  const pullsRealRepo = Boolean(automation.repoUrl);

  // Frozen now, not joined at aggregation time. Analytics used to read a
  // run's platform from the current Device record, so removing a device
  // rewrote history — an old Android run silently became unattributed.
  // A best-effort read: a device that cannot be resolved leaves the fields
  // null rather than blocking the trigger, since the lock acquisition below
  // is what actually decides whether this run may proceed.
  const device = await getDevice(input.deviceUdid).catch(() => null);

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
    snapshot: {
      platform: device?.platform ?? null,
      deviceModel: device?.model ?? null,
      deviceName: device?.name ?? null,
      framework: automation.framework ?? null,
      // How the operator addressed the suite. A tag and a feature path select
      // different sets, so recording which one it was is what stops analytics
      // comparing them as though they were the same suite.
      suiteKind: classifySuite(input.suite),
      // Filled in after `pulling`; there is nothing to resolve yet.
      commit: null,
    },
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
  void runExecution(run, input, automation, appiumConfig).catch((err: unknown) => {
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
  context: { env?: NodeJS.ProcessEnv; redact?: (text: string) => string } = {},
): Promise<RunOutcome> {
  const redact = context.redact ?? ((text: string) => text);
  const onChunk = (chunk: Buffer): void => {
    // Redacted before it reaches either sink: the log file is served over an
    // API and the WS stream goes to any viewer, so a secret written to either
    // has already escaped.
    const line = redact(chunk.toString());
    logStream.write(line);
    publishExecutionEvent(runId, { type: 'log', line });
  };

  const managed = supervisor.run({
    command: cmd.command,
    args: cmd.args,
    cwd,
    env: context.env,
    onStdout: onChunk,
    onStderr: onChunk,
  });
  runningProcesses.set(runId, managed);

  return managed.result;
}

/**
 * Lockfiles worth hashing, in a fixed order so the key is deterministic
 * regardless of directory-listing order. All present ones contribute — a repo
 * that carries two is unusual, but silently picking one would make the key
 * depend on which name happened to sort first.
 */
const LOCKFILE_NAMES = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'] as const;

/**
 * All four inputs `docs/modules/execution.md` requires: package.json, every
 * lockfile present, the platform, and the Node version.
 *
 * Hashing the lockfile alone — what this did before — is called out in that
 * spec as a *confirmed* collision source in the prior reference
 * implementation, not a theoretical one: a lockfile can be regenerated with
 * identical content after a meaningful `package.json` change (a moved
 * dependency, a changed script, a bumped engines range), and it may not be
 * committed at all. Platform and Node version matter because `node_modules`
 * contains compiled native addons — restoring a linux/Node-20 tree onto
 * win32/Node-22 produces a cache "hit" that fails at require time, which is
 * far worse than a miss.
 *
 * Lockfile *names* are hashed alongside their contents so switching package
 * managers can't collide on identical content.
 *
 * Changing this formula orphans every existing cache directory: old keys
 * simply stop matching, the next run reports a miss and repopulates under the
 * new key. That is correct and safe — a stale entry is never served — but the
 * orphaned directories are not reclaimed, since nothing purges the cache yet
 * (the spec defers that to a maintenance task).
 *
 * Exported for testing: this is the part that actually breaks, and its failure
 * mode is a silently wrong cache hit rather than a visible error.
 */
export function computeCacheKey(
  repoDir: string,
  platform: string = process.platform,
  nodeVersion: string = process.version,
): string | null {
  const manifestPath = path.join(repoDir, 'package.json');
  // No package.json means this isn't a Node project we know how to cache.
  // Returning null is honest; guessing a key would cache an unknown tree.
  if (!fs.existsSync(manifestPath)) return null;

  const parts: string[] = [fs.readFileSync(manifestPath, 'utf8')];
  for (const name of LOCKFILE_NAMES) {
    const lockPath = path.join(repoDir, name);
    if (fs.existsSync(lockPath)) parts.push(name, fs.readFileSync(lockPath, 'utf8'));
  }
  parts.push(platform, nodeVersion);

  return crypto.createHash('sha256').update(parts.join('\n')).digest('hex');
}

/**
 * Thin, honest node_modules cache keyed by `computeCacheKey` above. A hit
 * copies straight into `repoDir/node_modules`; a miss is NOT an error — it is
 * the legitimate first-run state, logged plainly rather than silently claimed
 * as a hit. `saveCacheIfMissing` populates the cache after a successful
 * `setup` so the *next* run with the same key gets a real hit.
 */
async function restoreCache(
  run: IExecutionRun,
  repoDir: string,
  logStream: fs.WriteStream,
): Promise<{ cacheDir: string | null }> {
  const cacheKey = computeCacheKey(repoDir);
  run.cacheKey = cacheKey;

  if (!cacheKey) {
    const line = 'restoring_cache: no package.json found — nothing to key a cache on\n';
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

/** The directory name a runner's Allure reporter writes, per docs/modules/execution.md. */
const ALLURE_REPORT_DIRNAME = 'allure-report';

/**
 * Records test-case-level counts from the runner's Allure results.
 *
 * Same `finally`-before-cleanup ordering as the report collector, and for the
 * same reason: the results live inside the workspace, which the run deletes.
 * Unlike the report, only the numbers are kept — the raw result files are a
 * few hundred KB per run and the report already renders them.
 *
 * Runs on every terminal path including failures, which is when the
 * distinction matters most: `status: 'failed'` says the run failed, and this
 * says whether that was one flaky test or the whole suite.
 */
function collectTestSummary(run: IExecutionRun, logStream: fs.WriteStream): void {
  let summary;
  try {
    summary = summarizeRunResults(run.workspacePath, ALLURE_RESULTS_DIRNAME);
  } catch (err) {
    // Best-effort, same as the report: failing to count tests must not turn a
    // passing run into a failed one.
    const line = `results: could not read Allure results: ${err instanceof Error ? err.message : String(err)}\n`;
    logStream.write(line);
    publishExecutionEvent(run.id as string, { type: 'log', line });
    return;
  }
  if (!summary) return;

  run.testSummary = summary;
  const line =
    `results: ${summary.passed}/${summary.total} tests passed` +
    (summary.failed > 0 ? `, ${summary.failed} failed` : '') +
    (summary.broken > 0 ? `, ${summary.broken} broken` : '') +
    (summary.skipped > 0 ? `, ${summary.skipped} skipped` : '') +
    '\n';
  logStream.write(line);
  publishExecutionEvent(run.id as string, { type: 'log', line });
}

/**
 * Adopts an Allure report the *runner* produced, if there is one.
 *
 * Mobile Hub deliberately does not generate reports — that needs a real
 * automation runner, which doesn't exist here yet. What it can honestly do is
 * notice a report a command already wrote and keep it. Until now `reportPath`
 * was declared on the model and written by nothing, so even a run that emitted
 * a perfectly good report had nowhere to show it.
 *
 * **Ordering matters and is the whole reason this is called from `finally`
 * before the workspace is removed.** The runner writes the report inside the
 * workspace, and the workspace is deleted at the end of every run — so a
 * report left where the runner put it is destroyed by the same cleanup that
 * keeps the disk bounded. Copying it under `artifactsPath` first is what makes
 * the two compatible, exactly as `run.log` already is.
 *
 * Runs on every terminal path, including failures: a failed run is precisely
 * when a report is most useful.
 */
async function collectAllureReport(run: IExecutionRun, logStream: fs.WriteStream): Promise<void> {
  // Runs predating durable artifacts have no artifactsPath, and there is
  // nowhere safe to put a report for them.
  if (!run.artifactsPath) return;

  // The runner's cwd is the checkout when a repo was cloned and the workspace
  // root otherwise, so the report lands in one of two places.
  const candidates = [
    path.join(run.workspacePath, 'repo', ALLURE_REPORT_DIRNAME),
    path.join(run.workspacePath, ALLURE_REPORT_DIRNAME),
  ];
  // index.html, not just the directory: an empty or half-written folder is not
  // a report, and linking to one would be the dead-button case the UI avoids.
  const source = candidates.find((dir) => fs.existsSync(path.join(dir, 'index.html')));
  if (!source) return;

  const dest = path.join(run.artifactsPath, ALLURE_REPORT_DIRNAME);
  try {
    await fs.promises.cp(source, dest, { recursive: true });
    run.reportPath = dest;
    const line = `report: kept the Allure report the runner produced (${dest})\n`;
    logStream.write(line);
    publishExecutionEvent(run.id as string, { type: 'log', line });
  } catch (err) {
    // Best-effort, same reasoning as workspace cleanup below: failing to keep
    // a report must not turn a passing run into a failed one. reportPath stays
    // null, so the UI simply hides the link rather than offering a 404.
    const line = `report: found an Allure report but could not keep it: ${
      err instanceof Error ? err.message : String(err)
    }\n`;
    logStream.write(line);
    publishExecutionEvent(run.id as string, { type: 'log', line });
  }
}

/**
 * Records the commit the run actually executed against.
 *
 * `branch` alone does not identify what ran: a branch moves, so two runs of
 * `main` a week apart are different code, and a re-run of an old run against
 * "the same branch" is a different thing entirely. The commit is what makes a
 * result reproducible.
 *
 * Best-effort and silent on failure — a run that tested the app successfully
 * must not be failed because a metadata read did not work.
 */
async function recordCommit(run: IExecutionRun, repoDir: string): Promise<void> {
  let out = '';
  const managed = supervisor.run({
    command: 'git',
    args: ['rev-parse', 'HEAD'],
    cwd: repoDir,
    timeoutMs: 10_000,
    onStdout: (chunk) => {
      out += chunk.toString();
    },
  });
  const outcome = await managed.result;
  const sha = out.trim();
  if (!isSuccess(outcome) || !/^[0-9a-f]{40}$/.test(sha)) return;
  if (run.snapshot) run.snapshot.commit = sha;
  await run.save();
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
  appiumConfig?: EffectiveConfig['appium'],
): Promise<void> {
  const runId = run.id as string;
  fs.mkdirSync(run.workspacePath, { recursive: true });
  fs.mkdirSync(path.dirname(run.logPath), { recursive: true });
  const logStream = fs.createWriteStream(run.logPath, { flags: 'a' });
  // Commands run in the workspace root unless a real repo gets cloned into
  // it below, in which case they move to run inside the checkout instead.
  let cwd = run.workspacePath;
  let cacheDir: string | null = null;
  // Built once the Appium endpoint is known, so the runner and the install
  // step share one environment and one redactor.
  let runEnv = buildRunEnvironment({ configured: automation.env });
  const redact = createRedactor(automation.env);

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
      await recordCommit(run, repoDir);

      await setStage(run, 'restoring_cache', 'running');
      ({ cacheDir } = await restoreCache(run, repoDir, logStream));
      await run.save(); // persist cacheKey set inside restoreCache
      await setStage(run, 'restoring_cache', 'done');
    }

    if (input.setup && !cancelledRuns.has(runId)) {
      await setStage(run, 'installing', 'running');
      const setupOutcome = await runCommand(input.setup, cwd, logStream, runId, { env: runEnv, redact });
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

    // Started here rather than at trigger time: the server is only needed for
    // the suite itself, and a run that fails while cloning should not have
    // spun one up. Failing to get one is infrastructure, never a test result.
    if (appiumConfig?.enabled) {
      try {
        const device = await getDevice(input.deviceUdid);
        if (device) {
          // Cheap and up front: a missing driver otherwise surfaces only after
          // the runner has started and tried to open a session.
          await assertDriverInstalled(device.platform);
          const endpoint = await ensureAppiumServer(device, { appium: appiumConfig } as EffectiveConfig);
          const line = `Appium ready at ${endpoint.baseUrl} for ${device.udid}\n`;
          logStream.write(line);
          publishExecutionEvent(runId, { type: 'log', line });
          // The app under test, when the run named a build. Without this the
          // suite opens a session against whatever is already on screen and
          // every selector misses — which is exactly how a fully-working
          // pipeline still failed with NoSuchElementError.
          const build = run.buildId ? await getBuild(run.buildId.toString()) : null;
          if (run.buildId && !build?.artifactPath) {
            throw new Error(
              `Build ${run.buildId.toString()} has no local artifact to run against — re-fetch it before running.`,
            );
          }

          runEnv = buildRunEnvironment({
            configured: automation.env,
            appium: endpoint,
            device: {
              udid: device.udid,
              name: device.name,
              platform: device.platform,
              osVersion: device.osVersion,
            },
            appPath: build?.artifactPath ?? undefined,
          });
        }
      } catch (err) {
        await setStage(run, 'execute', 'error', err instanceof Error ? err.message : String(err));
        await failRun(run, 'infra');
        return;
      }
    }

    const runOutcome = await runCommand(input.run, cwd, logStream, runId, { env: runEnv, redact });

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
    // Before `run.save()` so `reportPath` is persisted by it, and before the
    // workspace is removed below — the report lives inside the workspace until
    // this copies it out. Both orderings are load-bearing.
    await collectAllureReport(run, logStream);
    // Before `run.save()` and before the workspace is removed, for the same
    // two reasons as the report above.
    collectTestSummary(run, logStream);

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
  /** Lets an analytics suite breakdown link straight to the runs behind a number. */
  suite?: string;
}): Promise<IExecutionRun[]> {
  const query: Record<string, unknown> = {};
  if (filters.project) query.project = filters.project;
  if (filters.status) query.status = filters.status;
  if (filters.deviceUdid) query.deviceUdid = filters.deviceUdid;
  if (filters.suite) query.suite = filters.suite;
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
/**
 * Deletes workspaces belonging to runs that are already finished.
 *
 * Runs clean up after themselves now, but only since that was built — this
 * clears the backlog left by every run that finished before it, which on a
 * developer machine was hundreds of directories each holding a git clone and a
 * copied `node_modules`. Also catches anything a crash left behind, since a
 * process killed mid-run never reaches its own `finally`.
 *
 * Deliberately conservative: a directory is removed only when it maps to a run
 * that exists and has ended. An unrecognised directory is left alone rather
 * than assumed to be junk — `EXECUTIONS_DIR` also holds the shared `.cache`,
 * which must survive.
 */
export async function sweepFinishedWorkspaces(): Promise<number> {
  if (!fs.existsSync(env.EXECUTIONS_DIR)) return 0;

  const entries = fs.readdirSync(env.EXECUTIONS_DIR, { withFileTypes: true });
  const candidates = entries
    .filter((e) => e.isDirectory() && Types.ObjectId.isValid(e.name))
    .map((e) => e.name);
  if (candidates.length === 0) return 0;

  const known = await ExecutionRun.find({ _id: { $in: candidates } }).select('_id status');
  const statusById = new Map(known.map((r) => [r.id as string, r.status]));

  const removable = candidates.filter((id) => {
    const status = statusById.get(id);
    if (status) return (['passed', 'failed', 'cancelled'] as RunStatus[]).includes(status);

    // No record at all. Usually the database was reset while the disk was not,
    // which leaves workspaces nothing will ever claim — the actual cause of the
    // backlog here. Guarded by age because a run creates its directory around
    // the same moment as its record, and sweeping a starting run's workspace
    // would break it; nothing legitimately sits recordless for an hour.
    const dir = path.join(env.EXECUTIONS_DIR, id);
    try {
      return Date.now() - fs.statSync(dir).mtimeMs > ORPHAN_WORKSPACE_GRACE_MS;
    } catch {
      return false;
    }
  });

  let removed = 0;
  for (const id of removable) {
    try {
      fs.rmSync(path.join(env.EXECUTIONS_DIR, id), { recursive: true, force: true });
      removed += 1;
    } catch {
      // A locked file on Windows just means this one waits for the next boot;
      // failing startup over reclaimable disk space would be worse.
    }
  }
  return removed;
}

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
