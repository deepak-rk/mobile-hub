import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { identifyInstalledPackage, parsePackageList, cachedBuildPath, isCacheValid, ensureCachedBuild } from './installer';
import type { HubClient } from './hub-client';

/**
 * Post-install verification's two pure parts. These are the pieces that
 * actually break: `pm list packages` output varies by Android version, and a
 * misparse would make either every package or no package look changed — which
 * would turn verification into either a false alarm on every install or a
 * silent no-op, and a check that silently no-ops reads as a guarantee it
 * isn't giving.
 */
describe('parsePackageList', () => {
  it('parses names and version codes from a modern device', () => {
    const packages = parsePackageList(
      ['package:com.android.settings versionCode:33', 'package:com.wdiodemoapp versionCode:2'].join('\n'),
    );
    expect(packages.get('com.android.settings')).toBe('33');
    expect(packages.get('com.wdiodemoapp')).toBe('2');
  });

  it('records a null version when the device is too old for --show-versioncode', () => {
    // Distinct from "version 0": null means unknown, and callers must not read
    // unknown-to-unknown as evidence a package is unchanged.
    const packages = parsePackageList('package:com.example.legacy');
    expect(packages.has('com.example.legacy')).toBe(true);
    expect(packages.get('com.example.legacy')).toBeNull();
  });

  it('tolerates CRLF and blank lines', () => {
    // adb over Windows emits CRLF; an unhandled \r would become part of the
    // version string and make every package look changed.
    const packages = parsePackageList('package:com.a versionCode:1\r\n\r\npackage:com.b versionCode:2\r\n');
    expect([...packages.keys()]).toEqual(['com.a', 'com.b']);
    expect(packages.get('com.a')).toBe('1');
  });

  it('ignores lines that are not package entries', () => {
    const packages = parsePackageList(['WARNING: linker: something', 'package:com.real versionCode:5'].join('\n'));
    expect([...packages.keys()]).toEqual(['com.real']);
  });

  it('returns an empty map for empty output', () => {
    expect(parsePackageList('').size).toBe(0);
  });
});

describe('identifyInstalledPackage', () => {
  it('identifies a package that was not previously installed', () => {
    const before = new Map([['com.other', '1']]);
    const after = new Map([
      ['com.other', '1'],
      ['com.wdiodemoapp', '2'],
    ]);
    expect(identifyInstalledPackage(before, after)).toBe('com.wdiodemoapp');
  });

  it('identifies an upgrade by its changed version code', () => {
    const before = new Map([['com.wdiodemoapp', '1']]);
    const after = new Map([['com.wdiodemoapp', '2']]);
    expect(identifyInstalledPackage(before, after)).toBe('com.wdiodemoapp');
  });

  it('returns null for a same-version reinstall', () => {
    // The common case here: `pm install -r` of an already-present build leaves
    // the table identical, so no package can be attributed to this run. Null
    // means "unknown", and the caller must not treat it as verified.
    const before = new Map([['com.wdiodemoapp', '2']]);
    const after = new Map([['com.wdiodemoapp', '2']]);
    expect(identifyInstalledPackage(before, after)).toBeNull();
  });

  it('does not treat unknown-to-unknown versions as a change', () => {
    // An older device reports no version codes at all; every package would
    // otherwise look changed on every install.
    const before = new Map([['com.wdiodemoapp', null]]);
    const after = new Map([['com.wdiodemoapp', null]]);
    expect(identifyInstalledPackage(before, after)).toBeNull();
  });

  it('returns null when several packages changed at once', () => {
    // Something else installed concurrently, so no single candidate can be
    // attributed to this run — guessing one would verify the wrong app.
    const before = new Map<string, string | null>();
    const after = new Map([
      ['com.a', '1'],
      ['com.b', '1'],
    ]);
    expect(identifyInstalledPackage(before, after)).toBeNull();
  });

  it('returns null when the device could not be queried at all', () => {
    // listInstalledPackages yields an empty map when adb fails; that must read
    // as unverified rather than as a change.
    expect(identifyInstalledPackage(new Map(), new Map())).toBeNull();
  });
});

/**
 * The agent's own per-build cache — skips re-downloading a build it already
 * fetched. `cacheDir` is always a fresh temp directory here, never the real
 * per-agent cache: `ensureCachedBuild`'s default argument is the only thing
 * that ever points at `~/.mobile-hub-agent`, and no test exercises the default.
 */
describe('build cache (cachedBuildPath / isCacheValid / ensureCachedBuild)', () => {
  let cacheDir: string;

  afterEach(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  function freshCacheDir(): string {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-agent-cache-'));
    return cacheDir;
  }

  /** A fake hub whose `downloadArtifact` really writes bytes, like the real one. */
  function fakeHub(bytes: Buffer, calls: string[] = []) {
    return {
      downloadArtifact: async (buildId: string, destPath: string, onProgress?: (d: number, t: number | null) => void) => {
        calls.push(buildId);
        fs.writeFileSync(destPath, bytes);
        onProgress?.(bytes.length, bytes.length);
      },
    } as unknown as HubClient;
  }

  it('is invalid when the size is unknown, even if a file happens to exist', () => {
    const dir = freshCacheDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cachedBuildPath('b1', dir), Buffer.alloc(10));
    expect(isCacheValid('b1', null, dir)).toBe(false);
  });

  it('is invalid when nothing is cached yet', () => {
    const dir = freshCacheDir();
    expect(isCacheValid('b1', 10, dir)).toBe(false);
  });

  it('is invalid when the cached file size does not match', () => {
    const dir = freshCacheDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cachedBuildPath('b1', dir), Buffer.alloc(10));
    expect(isCacheValid('b1', 999, dir)).toBe(false);
  });

  it('is valid when the cached file size matches exactly', () => {
    const dir = freshCacheDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cachedBuildPath('b1', dir), Buffer.alloc(10));
    expect(isCacheValid('b1', 10, dir)).toBe(true);
  });

  it('downloads on a cache miss and leaves a valid cached file behind', async () => {
    const dir = freshCacheDir();
    const bytes = Buffer.alloc(50, 7);
    const calls: string[] = [];
    const hub = fakeHub(bytes, calls);

    const dest = await ensureCachedBuild(hub, 'b1', 50, () => {}, dir);

    expect(calls).toEqual(['b1']);
    expect(fs.readFileSync(dest)).toEqual(bytes);
  });

  it('skips the download entirely on a cache hit', async () => {
    const dir = freshCacheDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cachedBuildPath('b1', dir), Buffer.alloc(50));
    const calls: string[] = [];
    const hub = fakeHub(Buffer.alloc(50), calls);

    await ensureCachedBuild(hub, 'b1', 50, () => {}, dir);

    expect(calls).toEqual([]);
  });

  it('dedupes concurrent downloads of the same build', async () => {
    // Installing one build onto several devices on the same host fires one
    // runInstall per device without awaiting the others (agent.ts) — without
    // dedup, every one of them would race to write the same cached file.
    const dir = freshCacheDir();
    const calls: string[] = [];
    let resolveDownload: () => void = () => {};
    const gate = new Promise<void>((r) => (resolveDownload = r));
    const hub = {
      downloadArtifact: async (buildId: string, destPath: string) => {
        calls.push(buildId);
        await gate; // held open until the test releases it
        fs.writeFileSync(destPath, Buffer.alloc(30));
      },
    } as unknown as HubClient;

    const first = ensureCachedBuild(hub, 'b1', 30, () => {}, dir);
    const second = ensureCachedBuild(hub, 'b1', 30, () => {}, dir);
    resolveDownload();
    await Promise.all([first, second]);

    expect(calls).toEqual(['b1']); // only one real download, not two
  });
});
