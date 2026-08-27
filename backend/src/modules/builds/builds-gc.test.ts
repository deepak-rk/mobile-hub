import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Build } from './build.model';
import { ExecutionRun } from '../execution/execution-run.model';
import { env } from '../../config/env';
import { runBuildGc, BUILD_GC_INTERVAL_MS } from './builds.service';
import { PLATFORM_DEFAULTS, EffectiveConfig } from '../../config/org-config.schema';

/**
 * Real filesystem I/O against a temp dir, same reasoning as
 * builds.service.test.ts: the whole point is whether a file actually gets
 * deleted and the DB record actually gets updated to match, so mocking fs
 * away would prove nothing. No real database — Build.find/save and
 * ExecutionRun.exists are stubbed.
 */
let tmpDir: string;
let origBuildsDir: string;

interface FakeBuild {
  id: string;
  _id: string;
  project: string;
  platform: string;
  status: string;
  artifactPath: string | null;
  fetchedAt: Date | null;
  createdAt: Date;
  purgedAt: Date | null;
  save: () => Promise<void>;
}

function fakeBuild(overrides: Partial<FakeBuild> & { id: string }): FakeBuild {
  const doc: FakeBuild = {
    _id: overrides.id,
    project: 'p',
    platform: 'android',
    status: 'ready',
    artifactPath: null,
    fetchedAt: new Date(),
    createdAt: new Date(),
    purgedAt: null,
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return doc;
}

function writeArtifact(buildId: string, contents = 'artifact bytes'): string {
  const p = path.join(tmpDir, buildId);
  fs.writeFileSync(p, contents);
  return p;
}

function stubFind(builds: FakeBuild[]) {
  vi.spyOn(Build, 'find').mockReturnValue({
    sort: () => Promise.resolve(builds),
  } as never);
}

function stubReferenced(referencedIds: Set<string>) {
  vi.spyOn(ExecutionRun, 'exists').mockImplementation(
    ((query: { buildId: string }) => Promise.resolve(referencedIds.has(query.buildId) ? { _id: 'x' } : null)) as never,
  );
}

const config: EffectiveConfig = {
  ...PLATFORM_DEFAULTS,
  build: { ...PLATFORM_DEFAULTS.build, retention: { keepPerGroup: 2, olderThanDays: null } },
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-builds-gc-test-'));
  origBuildsDir = env.BUILDS_DIR;
  env.BUILDS_DIR = tmpDir;
});

afterEach(() => {
  env.BUILDS_DIR = origBuildsDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('runBuildGc', () => {
  it('keeps the N most recent ready builds per (project, platform) and purges the rest', async () => {
    const now = Date.now();
    const builds = [
      fakeBuild({ id: 'b3', fetchedAt: new Date(now) }),
      fakeBuild({ id: 'b2', fetchedAt: new Date(now - 1000) }),
      fakeBuild({ id: 'b1', fetchedAt: new Date(now - 2000) }), // beyond keepPerGroup=2
    ];
    builds.forEach((b) => writeArtifact(b.id));
    stubFind(builds);
    stubReferenced(new Set());

    const result = await runBuildGc(config);

    expect(result).toEqual({ purged: 1, skippedReferenced: 0, failures: [] });
    expect(fs.existsSync(path.join(tmpDir, 'b1'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'b2'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'b3'))).toBe(true);
    expect(builds[2].status).toBe('purged');
    expect(builds[2].purgedAt).toBeInstanceOf(Date);
    expect(builds[2].artifactPath).toBeNull();
    expect(builds[0].status).toBe('ready');
    expect(builds[1].status).toBe('ready');
  });

  it('keeps groups independent — a different (project, platform) has its own N', async () => {
    const now = Date.now();
    const builds = [
      fakeBuild({ id: 'a3', project: 'p', platform: 'android', fetchedAt: new Date(now) }),
      fakeBuild({ id: 'a2', project: 'p', platform: 'android', fetchedAt: new Date(now - 1000) }),
      fakeBuild({ id: 'a1', project: 'p', platform: 'android', fetchedAt: new Date(now - 2000) }),
      fakeBuild({ id: 'i1', project: 'p', platform: 'ios', fetchedAt: new Date(now - 2000) }),
    ];
    builds.forEach((b) => writeArtifact(b.id));
    stubFind(builds);
    stubReferenced(new Set());

    const result = await runBuildGc(config);

    // Only android's 3rd-ranked build is purged; ios has just 1, under the cap.
    expect(result.purged).toBe(1);
    expect(fs.existsSync(path.join(tmpDir, 'a1'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'i1'))).toBe(true);
  });

  it('never purges a build referenced by an ExecutionRun, regardless of rank', async () => {
    const now = Date.now();
    const builds = [
      fakeBuild({ id: 'b3', fetchedAt: new Date(now) }),
      fakeBuild({ id: 'b2', fetchedAt: new Date(now - 1000) }),
      fakeBuild({ id: 'b1', fetchedAt: new Date(now - 2000) }),
    ];
    builds.forEach((b) => writeArtifact(b.id));
    stubFind(builds);
    stubReferenced(new Set(['b1']));

    const result = await runBuildGc(config);

    expect(result).toEqual({ purged: 0, skippedReferenced: 1, failures: [] });
    expect(fs.existsSync(path.join(tmpDir, 'b1'))).toBe(true);
    expect(builds[2].status).toBe('ready');
  });

  it('honors olderThanDays as an additional gate on top of rank', async () => {
    const now = Date.now();
    const oldConfig: EffectiveConfig = {
      ...config,
      build: { ...config.build, retention: { keepPerGroup: 1, olderThanDays: 5 } },
    };
    const builds = [
      fakeBuild({ id: 'recent', fetchedAt: new Date(now) }),
      // Beyond keepPerGroup=1, but only 1 day old — not past the 5-day gate yet.
      fakeBuild({ id: 'young', fetchedAt: new Date(now - 24 * 60 * 60 * 1000) }),
      // Beyond keepPerGroup=1, and 10 days old — eligible.
      fakeBuild({ id: 'old', fetchedAt: new Date(now - 10 * 24 * 60 * 60 * 1000) }),
    ];
    builds.forEach((b) => writeArtifact(b.id));
    stubFind(builds);
    stubReferenced(new Set());

    const result = await runBuildGc(oldConfig);

    expect(result.purged).toBe(1);
    expect(fs.existsSync(path.join(tmpDir, 'old'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'young'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'recent'))).toBe(true);
  });

  it('is safe to run with nothing eligible', async () => {
    stubFind([fakeBuild({ id: 'only-one' })]);
    stubReferenced(new Set());

    await expect(runBuildGc(config)).resolves.toEqual({ purged: 0, skippedReferenced: 0, failures: [] });
  });

  it('is safe to run twice in a row — the second pass finds the file already gone and just is a no-op', async () => {
    const now = Date.now();
    const builds = [
      fakeBuild({ id: 'b3', fetchedAt: new Date(now) }),
      fakeBuild({ id: 'b2', fetchedAt: new Date(now - 1000) }),
      fakeBuild({ id: 'b1', fetchedAt: new Date(now - 2000) }),
    ];
    builds.forEach((b) => writeArtifact(b.id));
    stubFind(builds);
    stubReferenced(new Set());

    const first = await runBuildGc(config);
    expect(first.purged).toBe(1);

    // Second pass: Build.find would no longer return b1 as 'ready' in real
    // life (it's 'purged' now), but even if something re-queued it as a
    // candidate with a dangling artifactPath, deleting an already-missing
    // file must not throw or double-count.
    stubFind(builds);
    const second = await runBuildGc(config);
    expect(second.purged).toBe(1); // still finishes cleanly, still updates the record
    expect(second.failures).toEqual([]);
  });

  it('exports an interval constant matching the other periodic jobs\' style', () => {
    expect(BUILD_GC_INTERVAL_MS).toBeGreaterThan(0);
  });
});
