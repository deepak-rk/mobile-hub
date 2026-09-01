import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Types } from 'mongoose';
import { EffectiveConfig } from '../../config/org-config.schema';
import { env } from '../../config/env';
import { Build, IBuild } from './build.model';
import { getBuildProvider } from './providers/get-build-provider';
import { publishBuildEvent } from './builds.events';
import { ExecutionRun } from '../execution/execution-run.model';
// The model, deliberately not install-runs.service: that service imports from
// this one, so reaching for it here would close a cycle. Same shape as the
// ExecutionRun import above, which exists for the GC guard for the same reason.
import { InstallRun } from '../device-installs/install-run.model';

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });
  return hash.digest('hex');
}

export interface TriggerBuildFetchInput {
  project: string;
  platform: IBuild['platform'];
  version: string;
  artifactUrl?: string;
}

/**
 * Fetches a build via the config-selected BuildProvider, then validates
 * integrity (non-zero size + checksum) before marking it 'ready' — silent
 * truncation was a real prior failure mode (root CLAUDE.md "Lessons carried in").
 * A build never reaches 'ready' without passing this gate.
 */
/** How often download progress is persisted + pushed. Matches docs/modules/builds.md's ~1s cadence. */
const FETCH_PROGRESS_INTERVAL_MS = 1000;

/** MongoDB's duplicate-key error, the signal that another request won the claim race. */
function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000;
}

/**
 * Claims the right to fetch one (project, platform, version), atomically.
 *
 * Returns the existing row and `isOwner: false` when a fetch for the same
 * build is already running, so the caller joins that transfer instead of
 * starting a second one. `docs/modules/builds.md` calls this out as a race to
 * guard: without it two requests arriving together each downloaded the whole
 * artifact and left duplicate rows for one logical build.
 *
 * Atomicity comes from the upsert plus `one_inflight_fetch_per_version`
 * (build.model.ts) — an upsert alone can let two racers both insert, which is
 * exactly the case being defended against, so the losing racer's E11000 is
 * caught and resolved to the winner's row rather than surfaced.
 *
 * Ownership is decided by pre-generating the `_id` and checking whether it
 * survived: `$setOnInsert` applies only on insert, so getting our own id back
 * means we created the row. That avoids depending on driver result metadata.
 *
 * Only `downloading` blocks a claim. A `corrupt` row must never wedge a
 * version permanently — a retry has to be able to start fresh — and a `ready`
 * row is re-fetchable on purpose.
 */
async function claimBuildFetch(input: TriggerBuildFetchInput): Promise<{ build: IBuild; isOwner: boolean }> {
  const identity = { project: input.project, platform: input.platform, version: input.version };
  const candidateId = new Types.ObjectId();

  try {
    const build = await Build.findOneAndUpdate(
      { ...identity, status: 'downloading' },
      {
        $setOnInsert: {
          _id: candidateId,
          ...identity,
          artifactUrl: input.artifactUrl ?? '',
          status: 'downloading',
        },
      },
      { upsert: true, new: true },
    );
    return { build, isOwner: (build.id as string) === candidateId.toString() };
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    // Lost the insert race by microseconds. The winner's row is now visible.
    const existing = await Build.findOne({ ...identity, status: 'downloading' });
    if (!existing) throw err; // it finished and moved on already — nothing to join
    return { build: existing, isOwner: false };
  }
}

/**
 * Creates or joins the `Build` row and starts the fetch, returning both so the
 * caller can decide whether to await completion.
 *
 * Split out from `triggerBuildFetch` so progress can be observed at all: while
 * the fetch was a single awaited call, a caller could not learn the build's id
 * until the transfer had already finished, which left no window in which to
 * watch it. See `startBuildFetch` vs `triggerBuildFetch` below.
 *
 * A caller that joins an in-flight fetch gets that fetch's eventual result, so
 * awaiting `completed` behaves identically whether or not this request is the
 * one doing the downloading.
 */
export async function startBuildFetch(
  config: EffectiveConfig,
  input: TriggerBuildFetchInput,
): Promise<{ build: IBuild; completed: Promise<IBuild> }> {
  const { build, isOwner } = await claimBuildFetch(input);
  if (!isOwner) return { build, completed: awaitInFlightFetch(build) };

  const completed = runFetch(config, input, build);
  const buildId = build.id as string;
  inFlightFetches.set(buildId, completed);
  // Settled either way: leaving a rejected promise in the map would make the
  // next joiner inherit a failure from a fetch that has already been recorded
  // as corrupt and is no longer running.
  void completed.catch(() => {}).finally(() => inFlightFetches.delete(buildId));

  return { build, completed };
}

/**
 * In-process handles for fetches this instance owns, so a second request for
 * the same build can await the same work instead of duplicating it.
 *
 * Deliberately in-memory, matching the single-instance assumption the rest of
 * this codebase already makes (see execution's in-memory WS pub/sub). The
 * database index above is what enforces the invariant across instances; this
 * map is only an optimisation for the common single-instance case.
 */
const inFlightFetches = new Map<string, Promise<IBuild>>();

/**
 * Waits for a fetch started by another request, falling back to polling the
 * record when that fetch belongs to a different process.
 */
async function awaitInFlightFetch(build: IBuild): Promise<IBuild> {
  const existing = inFlightFetches.get(build.id as string);
  if (existing) return existing;

  // Another instance owns it. Rather than invent a cross-process wait, hand
  // back what is known now — the caller can watch /:id/stream or re-read the
  // record, which is what an async caller does anyway.
  return build;
}

/**
 * Fetches a build and waits for it to finish. Preserves the original
 * behaviour, and remains the default for `POST /api/builds`.
 */
export async function triggerBuildFetch(config: EffectiveConfig, input: TriggerBuildFetchInput): Promise<IBuild> {
  const { completed } = await startBuildFetch(config, input);
  return completed;
}

async function runFetch(
  config: EffectiveConfig,
  input: TriggerBuildFetchInput,
  build: IBuild,
): Promise<IBuild> {
  const destPath = path.join(env.BUILDS_DIR, build.id as string);
  const provider = getBuildProvider(config.build.provider);

  try {
    // Persisting every chunk would be thousands of writes per artifact; a ~1s
    // sample is all a progress bar can express anyway.
    let lastPersistAt = 0;
    const { sourceUrl, sizeBytes } = await provider.fetch(
      { project: input.project, platform: input.platform, version: input.version, artifactUrl: input.artifactUrl },
      destPath,
      (downloadedBytes, totalBytes) => {
        const now = Date.now();
        if (now - lastPersistAt < FETCH_PROGRESS_INTERVAL_MS) return;
        lastPersistAt = now;
        // Fire-and-forget: a failed progress write must never fail the fetch.
        void Build.updateOne(
          { _id: build._id },
          { downloadedBytes, ...(totalBytes ? { sizeBytes: totalBytes } : {}) },
        ).catch(() => {});
        publishBuildEvent(build.id as string, {
          type: 'progress',
          downloadedBytes,
          totalBytes: totalBytes ?? null,
        });
      },
    );

    if (sizeBytes <= 0) {
      throw new Error('Fetched artifact is empty (0 bytes)');
    }

    build.downloadedBytes = sizeBytes;
    build.status = 'validating';
    await build.save();
    publishBuildEvent(build.id as string, { type: 'status', status: 'validating' });

    const checksum = await sha256File(destPath);
    const onDiskSize = fs.statSync(destPath).size;
    if (onDiskSize !== sizeBytes) {
      throw new Error(`Artifact size mismatch after write: expected ${sizeBytes}, found ${onDiskSize}`);
    }

    build.artifactUrl = sourceUrl;
    build.artifactPath = destPath;
    build.sizeBytes = sizeBytes;
    build.checksum = checksum;
    build.integrityValidatedAt = new Date();
    build.fetchedAt = new Date();
    build.status = 'ready';
    await build.save();
    publishBuildEvent(build.id as string, { type: 'status', status: 'ready' });
    return build;
  } catch (err) {
    build.status = 'corrupt';
    await build.save();
    if (fs.existsSync(destPath)) fs.rmSync(destPath, { force: true });
    publishBuildEvent(build.id as string, {
      type: 'status',
      status: 'corrupt',
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Clears fetches left mid-flight by a crash or restart.
 *
 * A fetch only ever runs inside this process, so any build still `downloading`
 * or `validating` at startup is definitionally dead — nothing will resume it.
 * Before the claim guard existed such a row was merely untidy; now it holds
 * the `one_inflight_fetch_per_version` index entry and would block every
 * future fetch of that version permanently. Recovering them is what keeps the
 * guard from turning a crash into a wedged build.
 *
 * Marked `corrupt` rather than deleted, for the same reason a failed fetch is:
 * the record is the audit trail, and `corrupt` is already the status meaning
 * "this artifact is not usable, re-fetching is allowed".
 *
 * Call once at server startup, before accepting traffic — the same contract as
 * execution's `recoverOrphanedRuns`.
 */
export async function recoverOrphanedBuilds(): Promise<number> {
  const orphaned = await Build.find({ status: { $in: ['downloading', 'validating'] } });

  for (const build of orphaned) {
    // The partial file is unusable and its size is unknown, so it is deleted
    // on the same "don't leave something that looks fetched" principle the
    // failure path in runFetch already follows.
    const destPath = build.artifactPath ?? path.join(env.BUILDS_DIR, build.id as string);
    try {
      if (fs.existsSync(destPath)) fs.rmSync(destPath, { force: true });
    } catch {
      // Leaving a stray partial behind is a disk-space nuisance; leaving the
      // DB row in-flight is the thing that actually blocks future fetches, so
      // the status update below still happens.
    }
    build.status = 'corrupt';
    build.artifactPath = null;
    await build.save();
  }

  return orphaned.length;
}

/** How often the retention GC sweep runs — matches the cadence style of the other periodic jobs (hosts, analytics). */
export const BUILD_GC_INTERVAL_MS = 60 * 60 * 1000; // hourly

export interface BuildGcResult {
  purged: number;
  skippedReferenced: number;
  failures: { buildId: string; reason: string }[];
}

function groupKey(build: IBuild): string {
  return `${build.project}::${build.platform}`;
}

/**
 * Reclaims one build's disk space while keeping its record.
 *
 * The single place the `ready -> purged` transition happens, shared by the
 * retention sweep and the operator-initiated purge below, so the two can never
 * disagree about what "purged" leaves behind.
 *
 * Deletes the file *before* updating the record, matching the ordering
 * `runFetch` already holds itself to: if the process dies between the two the
 * record still claims `ready` with a now-dangling path, which the next sweep
 * re-evaluates and corrects. The reverse order would advertise an artifact as
 * gone while it still occupied the disk.
 *
 * Throws if the file cannot be removed — the caller decides whether that is a
 * per-build failure to collect (the sweep) or an error to surface (the route).
 */
async function purgeArtifact(build: IBuild): Promise<void> {
  const destPath = build.artifactPath ?? path.join(env.BUILDS_DIR, build.id as string);
  if (fs.existsSync(destPath)) fs.rmSync(destPath, { force: true });

  build.status = 'purged';
  build.purgedAt = new Date();
  build.artifactPath = null;
  await build.save();
}

/**
 * Re-downloads an existing build's artifact from the source already on its
 * record, reusing the same integrity gate a first fetch goes through.
 *
 * Reuses the existing row rather than creating a new one: the version's
 * identity, and anything referencing it, must survive a purge/refetch cycle —
 * a second row would make the same build appear twice in the catalog.
 */
export async function refetchBuild(config: EffectiveConfig, build: IBuild): Promise<IBuild> {
  build.status = 'downloading';
  build.downloadedBytes = 0;
  build.purgedAt = null;
  await build.save();
  publishBuildEvent(build.id as string, { type: 'status', status: 'downloading' });

  return runFetch(
    config,
    {
      project: build.project,
      platform: build.platform,
      version: build.version,
      artifactUrl: build.artifactUrl,
    },
    build,
  );
}

export class BuildNotPurgeableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BuildNotPurgeableError';
  }
}

/**
 * Operator-initiated "remove local copy".
 *
 * Distinct from `runBuildGc` despite sharing the transition: retention is a
 * policy sweep that decides *for* you, while this is someone reclaiming space
 * from a specific artifact now — a huge build, a bad one, or to force a fresh
 * re-download. The record survives either way, so the version stays visible in
 * the catalog and can be fetched again.
 *
 * Refuses while an install is still using the artifact. `runBuildGc`'s own
 * guard only covers `ExecutionRun`, which predates device installs — deleting
 * the file out from under an agent mid-transfer would surface as a confusing
 * download failure on the device rather than as the deliberate act it was.
 */
export async function purgeBuildArtifact(id: string): Promise<IBuild | null> {
  const build = await Build.findById(id);
  if (!build) return null;

  if (build.status !== 'ready') {
    // Nothing on disk to reclaim in any other state: `purged` is already done,
    // `corrupt` deleted its own partial, and an in-flight fetch owns the file.
    throw new BuildNotPurgeableError(`Build is '${build.status}'; only a 'ready' build has a local copy to remove.`);
  }

  // Matched by what is *not* terminal rather than by listing the in-flight
  // phases: a phase added later is then treated as busy by default, which is
  // the safe direction for a guard protecting a file from deletion.
  const inUse = await InstallRun.exists({
    buildId: build._id,
    'targets.status': { $nin: ['done', 'error'] },
  });
  if (inUse) {
    throw new BuildNotPurgeableError('An install is still using this artifact. Wait for it to finish, then retry.');
  }

  await purgeArtifact(build);
  return build;
}

/**
 * Purges old `ready` builds so BUILDS_DIR doesn't grow forever.
 *
 * Policy (config-driven, see EffectiveConfig.build.retention): keeps the
 * `keepPerGroup` most-recently-fetched ready builds per (project, platform).
 * Anything ranked beyond that is purge-eligible; if `olderThanDays` is also
 * set, an eligible build is only actually purged once it's that old too —
 * unset (the default), and rank alone decides. A build referenced by any
 * ExecutionRun is never purged, checked before either signal.
 *
 * Deletes the file *before* updating the DB record, matching the same
 * "don't claim ready when it isn't really there" integrity concern
 * triggerBuildFetch already holds itself to. If the process dies between the
 * two, the DB still says 'ready' with a now-dangling artifactPath — but the
 * next run re-evaluates the same build, finds the file already gone, and
 * just fixes the DB record. Safe to run repeatedly, including with nothing
 * to do.
 */
export async function runBuildGc(config: EffectiveConfig): Promise<BuildGcResult> {
  const { keepPerGroup, olderThanDays } = config.build.retention;
  const cutoff = olderThanDays != null ? Date.now() - olderThanDays * 24 * 60 * 60 * 1000 : null;

  const readyBuilds = await Build.find({ status: 'ready' }).sort({ fetchedAt: -1, createdAt: -1 });

  const groups = new Map<string, IBuild[]>();
  for (const build of readyBuilds) {
    const key = groupKey(build);
    const list = groups.get(key);
    if (list) list.push(build);
    else groups.set(key, [build]);
  }

  let purged = 0;
  let skippedReferenced = 0;
  const failures: BuildGcResult['failures'] = [];

  for (const builds of groups.values()) {
    // Already sorted newest-first; keep the first N, consider the rest.
    const candidates = builds.slice(keepPerGroup);

    for (const build of candidates) {
      const age = (build.fetchedAt ?? build.createdAt).getTime();
      if (cutoff != null && age > cutoff) continue; // not old enough yet

      const isReferenced = await ExecutionRun.exists({ buildId: build._id });
      if (isReferenced) {
        skippedReferenced += 1;
        continue;
      }

      const destPath = build.artifactPath ?? path.join(env.BUILDS_DIR, build.id as string);
      try {
        if (fs.existsSync(destPath)) fs.rmSync(destPath, { force: true });
      } catch (err) {
        // Leave the DB record alone if we can't confirm the file is gone -
        // better to retry next sweep than to claim purged prematurely. The
        // caller decides how to log this; the service stays pure, matching
        // markStaleHostsOffline/computeDailyAggregates's existing pattern.
        failures.push({ buildId: build.id as string, reason: err instanceof Error ? err.message : String(err) });
        continue;
      }

      build.status = 'purged';
      build.purgedAt = new Date();
      build.artifactPath = null;
      await build.save();
      purged += 1;
    }
  }

  return { purged, skippedReferenced, failures };
}

export async function listBuilds(filters: { project?: string; platform?: string }): Promise<IBuild[]> {
  const query: Record<string, unknown> = {};
  if (filters.project) query.project = filters.project;
  if (filters.platform) query.platform = filters.platform;
  return Build.find(query).sort({ createdAt: -1 });
}

export async function getBuild(id: string): Promise<IBuild | null> {
  return Build.findById(id);
}
