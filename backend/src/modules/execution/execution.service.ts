import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { Types } from 'mongoose';
import * as supervisor from '../../common/process-supervisor';
import {
  RunOutcome,
  describeOutcome,
  isSuccess,
  ManagedProcess,
} from '../../common/process-supervisor';
import { env } from '../../config/env';
import { EffectiveConfig, PLATFORM_DEFAULTS, ProjectConfig } from '../../config/org-config.schema';
import { acquireLock, getDevice, releaseLock } from '../devices/devices.service';
import { getBuild } from '../builds/builds.service';
import { assertDriverInstalled, ensureAppiumServer, closeActiveSessions } from './appium.service';
import { buildRunEnvironment, createRedactor } from './run-environment';
import { classifySuite } from './automation-commands';
import {
  summarizeRunResults,
  summarizeAllureResults,
  ALLURE_RESULTS_DIRNAME,
} from './allure-summary';
import {
  ExecutionRun,
  IExecutionRun,
  RunStatus,
  StageName,
  FailureKind,
  ErrorClass,
} from './execution-run.model';
import { publishExecutionEvent } from './execution.events';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors/app-error';

export class RunNotCancellableError extends ConflictError {
  constructor(status: string) {
    super(`Run is already ${status}`);
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
  /** Required when the project declares variants; rejected when it does not. */
  variant?: string;
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
// Runs whose orchestration is executing in *this* process, from claim to the
// end of `runExecution`. Distinct from `runningProcesses`, which only holds a
// run while one of its commands is alive — between commands a run is still
// owned here and must still see a cancel.
const ownedRuns = new Set<string>();

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
  project?: ProjectConfig,
): Promise<IExecutionRun> {
  assertVariantAllowed(project, input.variant);
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
  const device = await getDevice(input.deviceUdid, input.machineId).catch(() => null);
  if (
    device &&
    project &&
    project.platforms.length > 0 &&
    !project.platforms.includes(device.platform)
  ) {
    throw new ValidationError(
      `${project.displayName} is not declared for ${device.platform} (platforms: ${project.platforms.join(', ')}). Pick a device on a declared platform.`,
      'PLATFORM_NOT_SUPPORTED',
    );
  }

  const run = await ExecutionRun.create({
    _id: runId,
    machineId: input.machineId,
    deviceUdid: input.deviceUdid,
    buildId: input.buildId ?? null,
    project: input.project,
    branch: input.branch,
    variant: input.variant ?? null,
    suite: input.suite,
    triggeredBy: input.triggeredBy,
    executor: { kind: 'hub', machineId: env.HUB_MACHINE_ID },
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
    // Frozen for the same reason `snapshot` is: `dispatchQueuedRuns` may start
    // this run long after the request that resolved these commands (a config
    // override, or the config-derived default) has ended.
    commands: { setup: input.setup ?? null, run: input.run },
    workspacePath,
    artifactsPath,
    logPath,
  });

  // A device whose host stopped reporting it is not "busy" — queueing behind
  // it would wait forever. Fail now, with the reason, instead of letting the
  // run start and die minutes later at Appium startup.
  if (isGoneOffline(device)) {
    await failForOfflineDevice(run);
    return run;
  }

  const locked = await acquireLock(
    input.deviceUdid,
    input.triggeredBy,
    runId.toString(),
    `execution:${runId.toString()}`,
    input.machineId,
  );
  if (locked && !(await claimQueuedRun(run))) {
    // Cancelled in the instant between create and claim — nothing to run.
    await releaseLock(input.deviceUdid, input.triggeredBy, true, input.machineId);
    return run;
  }
  if (!locked) {
    // The device is busy, not broken: leave the run `queued` (its create
    // default) rather than failing it. `dispatchQueuedRuns` — run on a timer
    // from server.ts, same shape as `markStaleHostsOffline`/
    // `releaseExpiredLocks` — starts it once the device frees up. Returning
    // it as-is rather than throwing is what makes this a queue instead of a
    // 409: the caller sees a normal 201 with `status: 'queued'`.
    return run;
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
 * 1-based position of a queued run among others queued for the *same
 * device*, oldest first — locking is per-device, so that's the only queue
 * that actually exists. Null when the run isn't queued at all.
 */
export async function getQueuePosition(run: IExecutionRun): Promise<number | null> {
  if (run.status !== 'queued') return null;
  const ahead = await ExecutionRun.countDocuments({
    deviceUdid: run.deviceUdid,
    status: 'queued',
    createdAt: { $lt: run.createdAt },
  });
  return ahead + 1;
}

/**
 * How often `dispatchQueuedRuns` is polled from `server.ts`. Snappier than
 * the lock-expiry/stale-host sweeps (60s/10s) because a queued run starting
 * promptly once a device frees up is the entire point of building a real
 * queue instead of a 409 — but not so tight it hammers Mongo on an idle farm.
 */
export const QUEUE_DISPATCH_INTERVAL_MS = 5_000;

/**
 * Starts whichever queued runs can now proceed, one per device per pass.
 *
 * Only the *oldest* queued run for a given device is ever attempted on one
 * pass — a later run for the same device must not start ahead of an earlier
 * one still waiting, which is what actually makes this FIFO rather than
 * whichever run happens to win the lock race.
 */
export async function dispatchQueuedRuns(config: EffectiveConfig): Promise<number> {
  const queued = await ExecutionRun.find({ status: 'queued' }).sort({ createdAt: 1 });
  const attemptedDevices = new Set<string>();
  let started = 0;

  for (const candidate of queued) {
    if (attemptedDevices.has(candidate.deviceUdid)) continue;
    attemptedDevices.add(candidate.deviceUdid);

    // A queued run waiting on a device whose host has gone away would
    // otherwise wait forever — the lock it is waiting for is never contended,
    // the device is simply not there.
    const device = await getDevice(candidate.deviceUdid, candidate.machineId).catch(() => null);
    if (isGoneOffline(device)) {
      await failForOfflineDevice(candidate);
      continue;
    }

    const locked = await acquireLock(
      candidate.deviceUdid,
      candidate.triggeredBy,
      candidate.id as string,
      `execution:${candidate.id as string}`,
      candidate.machineId,
    );
    if (!locked) continue; // still busy — leave it queued, try again next tick

    // Atomic claim rather than "re-read and check": a cancel, or a second
    // dispatch tick, landing between the list above and this point loses the
    // write instead of being overwritten by it.
    const run = candidate;
    if (!run.commands || !(await claimQueuedRun(run))) {
      await releaseLock(candidate.deviceUdid, candidate.triggeredBy, true, candidate.machineId);
      continue;
    }

    const automation = config.projects[run.project]?.automation ?? config.automation;
    void runExecution(
      run,
      {
        machineId: run.machineId,
        deviceUdid: run.deviceUdid,
        buildId: run.buildId?.toString(),
        project: run.project,
        branch: run.branch,
        suite: run.suite,
        triggeredBy: run.triggeredBy,
        setup: run.commands.setup ?? undefined,
        run: run.commands.run,
      },
      automation,
      config.appium,
    ).catch((err: unknown) => {
      console.error(`Unhandled error running dequeued execution ${run.id as string}:`, err);
    });
    started += 1;
  }

  return started;
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
async function failRun(run: IExecutionRun, kind: FailureKind, errorClass: ErrorClass): Promise<void> {
  await setStatus(run, 'failed', { failureKind: kind, errorClass });
}

/** A run in one of these has a recorded outcome that nothing may overwrite. */
const TERMINAL_STATUSES: RunStatus[] = ['passed', 'failed', 'cancelled'];

/**
 * Writes a status transition atomically, and refuses to move a run out of a
 * terminal status.
 *
 * Was `run.status = x; run.save()`. That is a read-modify-write on an
 * in-memory copy, so two writers raced: a cancel landing while the dispatcher
 * started the same run could be silently undone (the run executed anyway
 * while the UI said cancelled), and a late or duplicate failure could
 * overwrite a recorded pass. A production device farm in this same domain
 * shipped exactly that second bug — a duplicate worker's failure overwrote a
 * real pass — and its fix is the rule applied here: a late or duplicate
 * failure must never overwrite a recorded outcome (`docs/LESSONS.md`
 * 2026-11-21).
 *
 * The in-memory copy is updated to match but its paths are *unmarked*, so a
 * later `run.save()` (stages, report path, timings) never re-writes status
 * from a stale copy. Returns false when the write was refused.
 */
export async function setStatus(
  run: IExecutionRun,
  status: RunStatus,
  extra: { failureKind?: FailureKind; errorClass?: ErrorClass } = {},
): Promise<boolean> {
  // A cancel is always classed as one, whichever path wrote it.
  if (status === 'cancelled' && extra.errorClass === undefined) extra = { ...extra, errorClass: 'cancelled' };
  const result = await ExecutionRun.updateOne(
    { _id: run._id, status: { $nin: TERMINAL_STATUSES } },
    { $set: { status, ...extra } },
  );
  if (result.matchedCount === 0) return false;
  run.status = status;
  run.unmarkModified('status');
  if (extra.failureKind !== undefined) {
    run.failureKind = extra.failureKind;
    run.unmarkModified('failureKind');
  }
  if (extra.errorClass !== undefined) {
    run.errorClass = extra.errorClass;
    run.unmarkModified('errorClass');
  }
  publishExecutionEvent(run.id as string, { type: 'status', status });
  return true;
}

/**
 * The one place a run leaves `queued`: an atomic `queued → preparing`.
 *
 * Whoever wins this write owns the run; a loser (a second dispatch tick, a
 * cancel that landed first) touches nothing. Before this, the trigger path
 * and the dispatcher each read a run, saw `queued`, and later wrote
 * `preparing` from that read — so a cancel in between was overwritten.
 */
async function claimQueuedRun(run: IExecutionRun): Promise<boolean> {
  const startedAt = new Date();
  const result = await ExecutionRun.updateOne(
    { _id: run._id, status: 'queued' },
    { $set: { status: 'preparing', startedAt } },
  );
  if (result.modifiedCount === 0) return false;
  run.status = 'preparing';
  run.startedAt = startedAt;
  run.unmarkModified('status');
  run.unmarkModified('startedAt');
  publishExecutionEvent(run.id as string, { type: 'status', status: 'preparing' });
  return true;
}

/**
 * How long a device may sit offline before runs waiting on it are failed
 * instead of left queued. Long enough to ride out a transient blip (the
 * stale-host sweep marks a host offline after 30 s); short enough that
 * someone waiting on a run learns the device is gone in minutes, not never.
 */
export const OFFLINE_FAIL_FAST_MS = 2 * 60_000;

function isGoneOffline(device: { status: string; lastSeenAt?: Date | null } | null): boolean {
  if (!device || (device.status !== 'offline' && device.status !== 'unreachable')) return false;
  const lastSeen = device.lastSeenAt ? new Date(device.lastSeenAt).getTime() : 0;
  return Date.now() - lastSeen > OFFLINE_FAIL_FAST_MS;
}

/**
 * Fails a run whose device has been offline past the grace period, with the
 * reason on the record. A precondition failure — the run never touched the
 * app, so it must not count against the suite's pass rate.
 */
async function failForOfflineDevice(run: IExecutionRun): Promise<void> {
  const stage = run.stages.find((s) => s.name === 'execute');
  if (stage) {
    stage.status = 'error';
    stage.error = 'Device offline — its host has not reported it for over 2 minutes.';
  }
  run.endedAt = new Date();
  await run.save();
  await setStatus(run, 'failed', { failureKind: 'precondition', errorClass: 'device_offline' });
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
  context: { env?: NodeJS.ProcessEnv; redact?: (text: string) => string; timeoutMs?: number } = {},
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
    timeoutMs: context.timeoutMs,
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
/**
 * Copies `src` into `dest` one top-level entry at a time, checking
 * `isCancelled` between entries. Returns false when it stopped early.
 *
 * A single recursive `fs.cp` of a node_modules tree took 34 s live and could
 * not be interrupted, so a cancel landing during `restoring_cache` waited for
 * the whole copy. Per-package granularity bounds that wait to one package.
 */
export async function copyDirCancellable(
  src: string,
  dest: string,
  isCancelled: () => boolean,
): Promise<boolean> {
  await fs.promises.mkdir(dest, { recursive: true });
  for (const entry of await fs.promises.readdir(src)) {
    if (isCancelled()) return false;
    await fs.promises.cp(path.join(src, entry), path.join(dest, entry), { recursive: true });
  }
  return !isCancelled();
}

async function restoreCache(
  run: IExecutionRun,
  repoDir: string,
  logStream: fs.WriteStream,
  isCancelled: () => boolean,
): Promise<{ cacheDir: string | null; completed: boolean }> {
  const cacheKey = computeCacheKey(repoDir);
  run.cacheKey = cacheKey;

  if (!cacheKey) {
    const line = 'restoring_cache: no package.json found — nothing to key a cache on\n';
    logStream.write(line);
    publishExecutionEvent(run.id as string, { type: 'log', line });
    return { cacheDir: null, completed: true };
  }

  const cacheDir = path.join(env.EXECUTIONS_DIR, '.cache', cacheKey);
  // Complete snapshots only — a directory still being written, or one a crash
  // cut short, is a miss, not a poisoned hit.
  const hit = isCompleteCache(cacheDir);
  const line = hit
    ? `restoring_cache: cache hit (${cacheKey})\n`
    : `restoring_cache: no cache yet for ${cacheKey} — will populate after install\n`;
  logStream.write(line);
  publishExecutionEvent(run.id as string, { type: 'log', line });

  const completed = hit
    ? await copyDirCancellable(cacheDir, path.join(repoDir, 'node_modules'), isCancelled)
    : true;
  return { cacheDir, completed };
}

/** The directory name a runner's Allure reporter writes, per docs/modules/execution.md. */
const ALLURE_REPORT_DIRNAME = 'allure-report';

/**
 * Where a runner may write its raw results: the checkout when a repo was
 * cloned, the workspace root otherwise. Same two places the summary and
 * report collectors already searched.
 */
function resultsDirCandidates(workspacePath: string): string[] {
  return [
    path.join(workspacePath, 'repo', ALLURE_RESULTS_DIRNAME),
    path.join(workspacePath, ALLURE_RESULTS_DIRNAME),
  ];
}

function reportDirCandidates(workspacePath: string): string[] {
  return [
    path.join(workspacePath, 'repo', ALLURE_REPORT_DIRNAME),
    path.join(workspacePath, ALLURE_REPORT_DIRNAME),
  ];
}

/**
 * True only when the runner demonstrably wrote results and none of them were
 * tests: a results directory exists, and holds no `*-result.json`. No
 * directory at all says nothing (the project may not use Allure) and returns
 * false — the distinction `summarizeAllureResults`' own doc comment draws.
 */
export function ranZeroTests(workspacePath: string): boolean {
  const dir = resultsDirCandidates(workspacePath).find((d) => fs.existsSync(d));
  if (!dir) return false;
  return !fs.readdirSync(dir).some((f) => f.endsWith('-result.json'));
}

/**
 * Copies the runner's raw Allure results — every file, not only
 * `*-result.json` — into the run's durable artifacts directory.
 *
 * Every file because the narrower copy is a known trap: copying only the
 * result JSON keeps the counts and silently drops the step attachments and
 * screenshots those results reference. And kept at all because the workspace
 * is deleted at the end of every run: until now the summary was read in place
 * and the raw results were lost, so nothing could ever be re-derived from
 * them (after a fix to the summarizer, or to repair a run interrupted by a
 * restart).
 */
async function persistAllureResults(run: IExecutionRun, logStream: fs.WriteStream): Promise<void> {
  if (!run.artifactsPath) return;
  const source = resultsDirCandidates(run.workspacePath).find((d) => fs.existsSync(d));
  if (!source) return;
  try {
    await fs.promises.cp(source, path.join(run.artifactsPath, ALLURE_RESULTS_DIRNAME), {
      recursive: true,
    });
  } catch (err) {
    const line = `results: could not keep raw Allure results: ${err instanceof Error ? err.message : String(err)}\n`;
    logStream.write(line);
    publishExecutionEvent(run.id as string, { type: 'log', line });
  }
}

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
    // The persisted copy first — it is what survives the workspace — falling
    // back to the workspace for a run with nowhere durable to have copied to.
    summary =
      (run.artifactsPath
        ? summarizeAllureResults(path.join(run.artifactsPath, ALLURE_RESULTS_DIRNAME))
        : null) ?? summarizeRunResults(run.workspacePath, ALLURE_RESULTS_DIRNAME);
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
    '\n' +
    // The reasons go in the log too, not only onto the record. Someone reading
    // a failed run's tail should not have to open another view to learn
    // whether this was one problem hitting twenty tests or twenty problems.
    summary.failures.map((f) => `  ${f.count}x ${f.message}\n`).join('');
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

/**
 * Written as the very last step of a cache snapshot. A cache directory only
 * counts as a hit when it carries this marker — see `isCompleteCache`.
 */
export const CACHE_COMPLETE_MARKER = '.mobilehub-cache-complete';

/** A cache entry is usable only if its snapshot finished. Existence alone is not enough. */
export function isCompleteCache(cacheDir: string): boolean {
  return fs.existsSync(path.join(cacheDir, CACHE_COMPLETE_MARKER));
}

/**
 * Snapshots `node_modules` into the shared cache atomically: copy into a
 * private temp directory, mark it complete, then rename into place.
 *
 * Was a direct copy into the final directory, with "the directory exists"
 * as the hit test. A crash, a cancel, or a second run with the same key
 * part-way through left a half-copied tree that then passed as a valid hit
 * for every later run, permanently — and a concurrent run could restore from
 * the directory while it was still being written. A production device farm
 * in this domain hit exactly this: a half-copied cache entry passed its
 * integrity check and every run with that key failed with
 * `Cannot find module` until the entry was found and deleted by hand.
 *
 * Exported for testing.
 */
export async function saveCacheIfMissing(repoDir: string, cacheDir: string | null): Promise<void> {
  if (!cacheDir || isCompleteCache(cacheDir)) return;
  const nodeModules = path.join(repoDir, 'node_modules');
  if (!fs.existsSync(nodeModules)) return;
  await fs.promises.mkdir(path.dirname(cacheDir), { recursive: true });

  const tmp = `${cacheDir}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    await fs.promises.cp(nodeModules, tmp, { recursive: true });
    fs.writeFileSync(path.join(tmp, CACHE_COMPLETE_MARKER), new Date().toISOString());
    // An incomplete entry from before this fix (no marker) is not a cache, it
    // is debris in the way — remove it so the rename can land.
    if (fs.existsSync(cacheDir) && !isCompleteCache(cacheDir))
      fs.rmSync(cacheDir, { recursive: true, force: true });
    await fs.promises.rename(tmp, cacheDir);
  } catch {
    // Lost the race to another run with the same key (its rename landed first)
    // or the copy failed. Either way the cache is no worse than before; never
    // fail a run over a cache write.
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function runExecution(
  run: IExecutionRun,
  input: TriggerExecutionInput,
  automation: EffectiveConfig['automation'],
  appiumConfig?: EffectiveConfig['appium'],
): Promise<void> {
  const runId = run.id as string;
  // Synchronous, before the first await: the claim that preceded this call
  // and ownership must not be separated by a tick a cancel could land in.
  ownedRuns.add(runId);
  fs.mkdirSync(run.workspacePath, { recursive: true });
  fs.mkdirSync(path.dirname(run.logPath), { recursive: true });
  const logStream = fs.createWriteStream(run.logPath, { flags: 'a' });
  // Commands run in the workspace root unless a real repo gets cloned into
  // it below, in which case they move to run inside the checkout instead.
  let cwd = run.workspacePath;
  let cacheDir: string | null = null;
  // Built once the Appium endpoint is known, so the runner and the install
  // step share one environment and one redactor.
  let runEnv = buildRunEnvironment({ configured: automation.env, variant: run.variant });
  const redact = createRedactor(automation.env);

  try {
    // `queued → preparing` (and startedAt) was already written atomically by
    // `claimQueuedRun` — whoever reached this point owns the run.

    // Every stage funnels through this so a cancel, a spawn failure, a
    // timeout and a nonzero exit all reach *both* the stage record and the run
    // status. The previous code updated the stage only on the nonzero-exit
    // path, which is how a run could read "failed" with a stage stuck on
    // "running" forever (docs/LESSONS.md).
    const settleStage = async (
      stage: StageName,
      outcome: RunOutcome,
      kindOnFailure: FailureKind,
      classOnFailure: ErrorClass,
    ): Promise<boolean> => {
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
      const kind =
        outcome.kind === 'spawn-failed' || outcome.kind === 'timeout' ? 'infra' : kindOnFailure;
      // A timeout in the test command is the run-length cap; earlier stages
      // time out on the network (clone, package fetch).
      const errorClass: ErrorClass =
        outcome.kind === 'timeout'
          ? stage === 'execute'
            ? 'run_timeout'
            : 'network_timeout'
          : outcome.kind === 'spawn-failed'
            ? 'unknown'
            : classOnFailure;
      await setStage(run, stage, 'error', describeOutcome(outcome));
      await failRun(run, kind, errorClass);
      return false;
    };

    if (automation.repoUrl && !cancelledRuns.has(runId)) {
      const repoDir = path.join(run.workspacePath, 'repo');
      await setStage(run, 'pulling', 'running');
      const cloneOutcome = await runCommand(
        {
          command: 'git',
          args: ['clone', '--branch', input.branch, '--single-branch', automation.repoUrl, repoDir],
        },
        run.workspacePath,
        logStream,
        runId,
      );
      // Cloning is the hub's own plumbing — a failure here says nothing about
      // the app under test.
      if (!(await settleStage('pulling', cloneOutcome, 'infra', 'checkout_failed'))) return;
      cwd = repoDir;
      await recordCommit(run, repoDir);

      await setStage(run, 'restoring_cache', 'running');
      const restored = await restoreCache(run, repoDir, logStream, () => cancelledRuns.has(runId));
      cacheDir = restored.cacheDir;
      await run.save(); // persist cacheKey set inside restoreCache
      if (!restored.completed) {
        await setStage(run, 'restoring_cache', 'error', 'cancelled');
        await setStatus(run, 'cancelled');
        return;
      }
      await setStage(run, 'restoring_cache', 'done');
    }

    if (input.setup && !cancelledRuns.has(runId)) {
      await setStage(run, 'installing', 'running');
      const gotSlot = await acquirePrepSlot(
        () => cancelledRuns.has(runId),
        (line) => {
          logStream.write(line);
          publishExecutionEvent(runId, { type: 'log', line });
        },
      );
      if (!gotSlot) {
        await setStage(run, 'installing', 'error', 'cancelled');
        await setStatus(run, 'cancelled');
        return;
      }
      try {
        const setupOutcome = await runCommand(input.setup, cwd, logStream, runId, {
          env: runEnv,
          redact,
        });
        // Dependency install failing is an environment problem, not a test result.
        if (!(await settleStage('installing', setupOutcome, 'infra', 'dependency_install_failed'))) return;
      } finally {
        releasePrepSlot();
      }
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
      // Narrowed below when the failure is the build rather than Appium.
      let setupClass: ErrorClass = 'appium_session';
      try {
        const device = await getDevice(input.deviceUdid, input.machineId);
        if (device) {
          // Cheap and up front: a missing driver otherwise surfaces only after
          // the runner has started and tried to open a session.
          await assertDriverInstalled(device.platform);
          const endpoint = await ensureAppiumServer(device, {
            appium: appiumConfig,
          } as EffectiveConfig);
          const line = `Appium ready at ${endpoint.baseUrl} for ${device.udid}\n`;
          logStream.write(line);
          publishExecutionEvent(runId, { type: 'log', line });
          // The app under test, when the run named a build. Without this the
          // suite opens a session against whatever is already on screen and
          // every selector misses — which is exactly how a fully-working
          // pipeline still failed with NoSuchElementError.
          const build = run.buildId ? await getBuild(run.buildId.toString()) : null;
          if (run.buildId && !build?.artifactPath) {
            setupClass = 'build_missing';
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
            runId,
            variant: run.variant,
          });
        }
      } catch (err) {
        await setStage(run, 'execute', 'error', err instanceof Error ? err.message : String(err));
        await failRun(run, 'infra', setupClass);
        return;
      }
    }

    // Results already sitting in the checkout — committed to the test repo, or
    // left by an earlier tool run in the same tree — would otherwise be read
    // back as *this* run's results: wrong numbers, or a run that executed
    // nothing still showing a full suite. Only what this run writes counts.
    for (const dir of [
      ...resultsDirCandidates(run.workspacePath),
      ...reportDirCandidates(run.workspacePath),
    ]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    const runOutcome = await runCommand(input.run, cwd, logStream, runId, {
      env: runEnv,
      redact,
      timeoutMs: env.EXECUTION_MAX_RUN_MINUTES * 60_000,
    });

    // The only stage whose nonzero exit is a genuine *test* result.
    if (!(await settleStage('execute', runOutcome, 'test', 'test_assertion'))) return;

    // Exit 0 is not a pass if nothing ran. A tag or suite filter that matches
    // no tests makes the runner exit cleanly, and reporting that as green is
    // a wrong result. Only decidable when the runner wrote Allure results at
    // all — a project not using Allure gives no signal, so it is left alone.
    if (ranZeroTests(run.workspacePath)) {
      await setStage(
        run,
        'execute',
        'error',
        'The runner exited cleanly but executed no tests — the suite/tag filter matched nothing.',
      );
      await failRun(run, 'precondition', 'no_tests_matched');
      return;
    }
    await setStatus(run, 'passed');
  } catch (err) {
    publishExecutionEvent(runId, {
      type: 'log',
      line: `orchestration error: ${err instanceof Error ? err.message : String(err)}`,
    });
    // An exception in the orchestrator itself is infrastructure by definition.
    await failRun(run, 'infra', 'unknown');
  } finally {
    // First of all, before anything can fail or the workspace is removed:
    // keep the runner's raw results. They are the only source a result can be
    // rebuilt from later, and they used to be read in place and then deleted
    // with the workspace.
    await persistAllureResults(run, logStream);
    // Before `run.save()` so `reportPath` is persisted by it, and before the
    // workspace is removed below — the report lives inside the workspace until
    // this copies it out. Both orderings are load-bearing.
    await collectAllureReport(run, logStream);
    // Before `run.save()` and before the workspace is removed, for the same
    // two reasons as the report above.
    collectTestSummary(run, logStream);

    // Appium servers here are one-per-device and long-lived (reused across
    // many runs), so killing this run's process tree does not close any
    // WebDriver session it opened — that session lives inside a server this
    // run doesn't own. Left alone, the *next* run's session-creation fails
    // against a server that looks perfectly healthy. Best-effort: a device
    // this run never got as far as reaching an Appium session for (e.g.
    // cancelled during `pulling`) has nothing to clean up here.
    if (appiumConfig?.enabled) {
      const device = await getDevice(input.deviceUdid, input.machineId).catch(() => null);
      if (device)
        await closeActiveSessions(device, { appium: appiumConfig } as EffectiveConfig).catch(
          () => undefined,
        );
    }

    run.endedAt = new Date();
    await run.save();
    logStream.end();
    runningProcesses.delete(runId);
    cancelledRuns.delete(runId);
    ownedRuns.delete(runId);
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
    await releaseLock(input.deviceUdid, input.triggeredBy, true, input.machineId);
  }
}

export async function cancelExecutionRun(id: string): Promise<IExecutionRun | null> {
  const run = await ExecutionRun.findById(id);
  if (!run) return null;
  if (!(['queued', 'preparing', 'running'] as RunStatus[]).includes(run.status)) {
    throw new RunNotCancellableError(run.status);
  }

  // A queued run has no process to kill and never acquired the device lock —
  // `dispatchQueuedRuns` is what would otherwise start it, so removing it
  // from the queue is just setting its own status directly, not signalling a
  // live orchestration the way the running/preparing path below does.
  if (run.status === 'queued') {
    // Atomic: only wins if the run is *still* queued. If the dispatcher
    // claimed it a moment ago, this matches nothing and the run is cancelled
    // through the in-flight path below instead — rather than being written
    // `cancelled` while it goes on executing, which is what a read-then-save
    // here allowed.
    const endedAt = new Date();
    const result = await ExecutionRun.updateOne(
      { _id: run._id, status: 'queued' },
      { $set: { status: 'cancelled', endedAt } },
    );
    if (result.modifiedCount > 0) {
      run.status = 'cancelled';
      run.endedAt = endedAt;
      publishExecutionEvent(id, { type: 'status', status: 'cancelled' });
      return run;
    }
  }

  // Not executing here (an orphan a restart left behind, or a run that ended
  // between the read above and now): there is no orchestration to signal, so
  // signalling one did nothing and left the id in `cancelledRuns` forever.
  // Write the cancel directly instead — refused if it already finished.
  if (!ownedRuns.has(id)) {
    await setStatus(run, 'cancelled');
    return run;
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
  /**
   * Scopes `deviceUdid` to one host: an emulator serial like `emulator-5554`
   * repeats across hosts, so a udid alone would merge different devices' runs.
   */
  machineId?: string;
  /** Lets an analytics suite breakdown link straight to the runs behind a number. */
  suite?: string;
}): Promise<IExecutionRun[]> {
  const query: Record<string, unknown> = {};
  if (filters.project) query.project = filters.project;
  if (filters.status) query.status = filters.status;
  if (filters.machineId) query.machineId = filters.machineId;
  if (filters.deviceUdid) query.deviceUdid = filters.deviceUdid;
  if (filters.suite) query.suite = filters.suite;
  return ExecutionRun.find(query).sort({ createdAt: -1 });
}

export async function getExecutionRun(id: string): Promise<IExecutionRun | null> {
  return ExecutionRun.findById(id);
}

/** Runs currently in flight on this machine — for host diagnostics, not the run list itself. */
export async function getActiveRunCountForMachine(machineId: string): Promise<number> {
  return ExecutionRun.countDocuments({
    machineId,
    status: { $in: ['queued', 'preparing', 'running'] },
  });
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

export async function recoverOrphanedRuns(
  appiumConfig?: EffectiveConfig['appium'],
): Promise<number> {
  const orphaned = await ExecutionRun.find({ status: { $in: ['queued', 'preparing', 'running'] } });
  for (const run of orphaned) {
    // Whatever the runner finished before the restart is kept: its results
    // are still in the workspace (recovery runs before the workspace sweep).
    const summary = await repairRunFromResults(run);
    const failedTests = summary ? summary.failed + summary.broken : 0;
    const runningStage = run.stages.find((s) => s.status === 'running');
    if (runningStage) {
      runningStage.status = 'error';
      runningStage.error = summary
        ? `Backend restarted mid-run; results recovered for ${summary.total} test(s), ${failedTests} failed`
        : 'Backend restarted mid-run';
      runningStage.endedAt = new Date();
    }
    run.status = 'failed';
    // A restart is infrastructure, not a test result. But tests that had
    // already failed did fail, and blanket-classing those as a restart would
    // hide a real regression behind an infra excuse. A run whose recovered
    // tests all passed is still not called passed: the rest never ran.
    run.failureKind = failedTests > 0 ? 'test' : 'infra';
    run.errorClass = failedTests > 0 ? 'test_assertion' : 'hub_restarted';
    run.endedAt = new Date();
    await run.save();
    await releaseLock(run.deviceUdid, run.triggeredBy, true, run.machineId);
    // Same reason as runExecution's own finally block: a backend restart kills
    // this process's runner children, but not a session left open inside a
    // device's long-lived, separately-running Appium server.
    if (appiumConfig?.enabled) {
      const device = await getDevice(run.deviceUdid, run.machineId).catch(() => null);
      if (device)
        await closeActiveSessions(device, { appium: appiumConfig } as EffectiveConfig).catch(
          () => undefined,
        );
    }
  }
  return orphaned.length;
}

/**
 * Removes `<key>.tmp-*` snapshot directories left in the npm cache by a
 * process that died mid-copy (`saveCacheIfMissing` cleans up its own temp dir
 * in `finally`, which a crash or kill never reaches). They are never read —
 * restore only trusts the completion marker — but each one is a full
 * `node_modules` copy, so left alone they fill the disk. The production farm
 * this design came from listed exactly this as an open item.
 *
 * Boot-only: at that point no run in this process can be writing a snapshot.
 * Returns how many were removed.
 */
export async function sweepStaleCacheSnapshots(
  cacheRoot = path.join(env.EXECUTIONS_DIR, '.cache'),
): Promise<number> {
  let entries: string[];
  try {
    entries = await fs.promises.readdir(cacheRoot);
  } catch {
    return 0; // no cache yet
  }
  const stale = entries.filter((name) => /\.tmp-\d+-[0-9a-f]+$/.test(name));
  await Promise.all(
    stale.map((name) =>
      fs.promises.rm(path.join(cacheRoot, name), { recursive: true, force: true }),
    ),
  );
  return stale.length;
}

/**
 * A project with variants needs one per run, and only a declared one; a
 * project without them takes none. Checked at trigger time so a typo is a 400
 * now rather than a suite running against the wrong target minutes later.
 */
export function assertVariantAllowed(
  project: ProjectConfig | undefined,
  variant: string | undefined,
): void {
  const declared = project?.variants ?? [];
  const name = project?.displayName ?? 'This project';
  if (declared.length === 0) {
    if (variant) {
      throw new ValidationError(
        `${name} declares no variants, so a run cannot name one ('${variant}').`,
        'VARIANT_NOT_DECLARED',
      );
    }
    return;
  }
  if (!variant) {
    throw new ValidationError(
      `${name} declares variants; pick one of: ${declared.join(', ')}.`,
      'VARIANT_REQUIRED',
    );
  }
  if (!declared.includes(variant)) {
    throw new ValidationError(
      `Unknown variant '${variant}'. Declared: ${declared.join(', ')}.`,
      'VARIANT_UNKNOWN',
    );
  }
}

/**
 * Bounds concurrent dependency installs on this hub (EXECUTION_PREP_CONCURRENCY).
 * Not FIFO: a waiter re-checks on a short interval, which keeps a cancel
 * responsive without a waiter queue to clean up. Exported for tests.
 */
let prepActive = 0;
const PREP_POLL_MS = 500;

export async function acquirePrepSlot(isCancelled: () => boolean, log?: (line: string) => void): Promise<boolean> {
  let announced = false;
  while (prepActive >= env.EXECUTION_PREP_CONCURRENCY) {
    if (isCancelled()) return false;
    if (!announced) {
      log?.(`Waiting for a dependency-install slot (${prepActive} of ${env.EXECUTION_PREP_CONCURRENCY} in use)\n`);
      announced = true;
    }
    await new Promise((r) => setTimeout(r, PREP_POLL_MS));
  }
  if (isCancelled()) return false;
  prepActive += 1;
  return true;
}

export function releasePrepSlot(): void {
  prepActive = Math.max(0, prepActive - 1);
}

/** Test-only view of the counter. */
export function prepSlotsInUse(): number {
  return prepActive;
}

/**
 * Rebuilds a run's test summary from its raw results, keeping a durable copy
 * of them first. Repair only: it never changes a run's status and never
 * fails anything for results being absent (returns null).
 *
 * Used by restart recovery, so tests a runner finished before the hub went
 * down keep their outcome, and by the resync route, so a run can be
 * re-derived after a summarizer fix.
 */
export async function repairRunFromResults(run: IExecutionRun): Promise<IExecutionRun['testSummary']> {
  let logStream: fs.WriteStream | null = null;
  try {
    if (run.logPath) {
      fs.mkdirSync(path.dirname(run.logPath), { recursive: true });
      logStream = fs.createWriteStream(run.logPath, { flags: 'a' });
      // A log that cannot be appended to must not crash the process.
      logStream.on('error', () => {});
    }
    const sink = logStream ?? fs.createWriteStream(os.devNull);
    await persistAllureResults(run, sink);
    collectTestSummary(run, sink);
    if (!logStream) sink.end();
    return run.testSummary ?? null;
  } finally {
    logStream?.end();
  }
}

/**
 * Re-derives a finished run's test summary from its kept raw results, for
 * example after a fix to the summarizer. Never touches status: a recorded
 * outcome stays recorded. In-flight runs are refused, since their results
 * are still being written. `resynced: false` means there were no results to
 * read, which is not an error.
 */
export async function resyncExecutionRun(id: string): Promise<{ run: IExecutionRun; resynced: boolean }> {
  const run = await ExecutionRun.findById(id);
  if (!run) throw new NotFoundError('Execution run not found');
  if (!TERMINAL_STATUSES.includes(run.status)) {
    throw new ConflictError('Only a finished run can be resynced; this one is still in flight.', 'RUN_IN_FLIGHT');
  }
  const summary = await repairRunFromResults(run);
  if (!summary) return { run, resynced: false };
  // Field-level write, not run.save(): only the summary changes.
  await ExecutionRun.updateOne({ _id: run._id }, { $set: { testSummary: summary } });
  return { run, resynced: true };
}

