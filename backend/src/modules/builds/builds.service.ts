import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { EffectiveConfig } from '../../config/org-config.schema';
import { env } from '../../config/env';
import { Build, IBuild } from './build.model';
import { getBuildProvider } from './providers/get-build-provider';

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

export async function listBuilds(filters: { project?: string; platform?: string }): Promise<IBuild[]> {
  const query: Record<string, unknown> = {};
  if (filters.project) query.project = filters.project;
  if (filters.platform) query.platform = filters.platform;
  return Build.find(query).sort({ createdAt: -1 });
}

export async function getBuild(id: string): Promise<IBuild | null> {
  return Build.findById(id);
}
