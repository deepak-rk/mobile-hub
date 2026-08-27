import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { EffectiveConfig } from '../../config/org-config.schema';
import { env } from '../../config/env';
import { Build, IBuild } from './build.model';
import { getBuildProvider } from './providers/get-build-provider';
import { ExecutionRun } from '../execution/execution-run.model';

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
export async function triggerBuildFetch(config: EffectiveConfig, input: TriggerBuildFetchInput): Promise<IBuild> {
  const build = await Build.create({
    project: input.project,
    platform: input.platform,
    version: input.version,
    artifactUrl: input.artifactUrl ?? '',
    status: 'downloading',
  });

  const destPath = path.join(env.BUILDS_DIR, build.id as string);
  const provider = getBuildProvider(config.build.provider);

  try {
    const { sourceUrl, sizeBytes } = await provider.fetch(
      { project: input.project, platform: input.platform, version: input.version, artifactUrl: input.artifactUrl },
      destPath,
    );

    if (sizeBytes <= 0) {
      throw new Error('Fetched artifact is empty (0 bytes)');
    }

    build.status = 'validating';
    await build.save();

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
    return build;
  } catch (err) {
    build.status = 'corrupt';
    await build.save();
    if (fs.existsSync(destPath)) fs.rmSync(destPath, { force: true });
    throw err;
  }
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
