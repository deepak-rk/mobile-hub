import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { Build } from './build.model';
import { env } from '../../config/env';
import { triggerBuildFetch } from './builds.service';
import * as getProviderModule from './providers/get-build-provider';

/**
 * The whole point of this service is the integrity gate (root CLAUDE.md
 * "Lessons carried in": silent truncation was a real prior failure mode), so
 * these exercise real filesystem writes/reads through a fake provider rather
 * than mocking fs away — a mocked checksum would prove nothing. No database
 * is used: `Build.create`/the returned document's `.save()` are stubbed.
 */
let tmpDir: string;
let origBuildsDir: string;

function fakeDoc(overrides: Partial<Record<string, unknown>> = {}) {
  const doc: Record<string, unknown> = {
    id: 'build-1',
    status: 'downloading',
    artifactUrl: '',
    ...overrides,
  };
  (doc as { save: () => Promise<void> }).save = vi.fn().mockResolvedValue(undefined);
  return doc;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-builds-test-'));
  origBuildsDir = env.BUILDS_DIR;
  env.BUILDS_DIR = tmpDir;
});

afterEach(() => {
  env.BUILDS_DIR = origBuildsDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('triggerBuildFetch', () => {
  it('marks a build ready when size and checksum both check out', async () => {
    const bytes = Buffer.from('a real fake artifact');
    const expectedChecksum = crypto.createHash('sha256').update(bytes).digest('hex');

    vi.spyOn(getProviderModule, 'getBuildProvider').mockReturnValue({
      name: 'url',
      fetch: async (_ctx, destPath) => {
        fs.writeFileSync(destPath, bytes);
        return { sourceUrl: 'https://example.com/a.apk', sizeBytes: bytes.length };
      },
    });

    const doc = fakeDoc();
    vi.spyOn(Build, 'create').mockResolvedValue(doc as never);

    const result = await triggerBuildFetch(
      { build: { provider: 'url' } } as never,
      { project: 'p', platform: 'android', version: '1.0' },
    );

    expect(result.status).toBe('ready');
    expect(result.checksum).toBe(expectedChecksum);
    expect(result.sizeBytes).toBe(bytes.length);
    expect(fs.existsSync(path.join(tmpDir, 'build-1'))).toBe(true);
  });

  it('rejects a 0-byte artifact and marks the build corrupt', async () => {
    vi.spyOn(getProviderModule, 'getBuildProvider').mockReturnValue({
      name: 'url',
      fetch: async () => ({ sourceUrl: 'https://example.com/a.apk', sizeBytes: 0 }),
    });
    const doc = fakeDoc();
    vi.spyOn(Build, 'create').mockResolvedValue(doc as never);

    await expect(
      triggerBuildFetch({ build: { provider: 'url' } } as never, { project: 'p', platform: 'android', version: '1' }),
    ).rejects.toThrow(/empty/i);

    expect(doc.status).toBe('corrupt');
  });

  it('marks the build corrupt and deletes the partial file on a size mismatch', async () => {
    vi.spyOn(getProviderModule, 'getBuildProvider').mockReturnValue({
      name: 'url',
      fetch: async (_ctx, destPath) => {
        fs.writeFileSync(destPath, Buffer.from('short'));
        // Reports more bytes than were actually written — the exact
        // truncation scenario the integrity gate exists to catch.
        return { sourceUrl: 'https://example.com/a.apk', sizeBytes: 99999 };
      },
    });
    const doc = fakeDoc();
    vi.spyOn(Build, 'create').mockResolvedValue(doc as never);

    await expect(
      triggerBuildFetch({ build: { provider: 'url' } } as never, { project: 'p', platform: 'android', version: '1' }),
    ).rejects.toThrow(/size mismatch/i);

    expect(doc.status).toBe('corrupt');
    expect(fs.existsSync(path.join(tmpDir, 'build-1'))).toBe(false);
  });

  it('marks the build corrupt if the provider itself fails', async () => {
    vi.spyOn(getProviderModule, 'getBuildProvider').mockReturnValue({
      name: 'url',
      fetch: async () => {
        throw new Error('network unreachable');
      },
    });
    const doc = fakeDoc();
    vi.spyOn(Build, 'create').mockResolvedValue(doc as never);

    await expect(
      triggerBuildFetch({ build: { provider: 'url' } } as never, { project: 'p', platform: 'android', version: '1' }),
    ).rejects.toThrow('network unreachable');

    expect(doc.status).toBe('corrupt');
  });
});
