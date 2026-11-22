import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  identifyInstalledPackage,
  parsePackageList,
  cachedBuildPath,
  isCacheValid,
  ensureCachedBuild,
  parseUngrantedRuntimePermissions,
  grantRuntimePermissions,
  describePermissionGrantNote,
  verifyPackageInstalled,
} from './installer';
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
 * Parses `dumpsys package`'s "runtime permissions:" block — the one dumpsys
 * already separates from normal/signature permissions, which is exactly the
 * subset `pm grant` can act on. Not parsed from the APK via `aapt`: not
 * guaranteed present on this agent, same reasoning as `identifyInstalledPackage`.
 */
describe('parseUngrantedRuntimePermissions', () => {
  it('extracts only the ungranted permissions from a real-shaped dumpsys block', () => {
    const dumpsys = [
      'Packages:',
      '  Package [com.wdiodemoapp] (abcdef):',
      '    requested permissions:',
      '      android.permission.CAMERA',
      '      android.permission.RECORD_AUDIO',
      '      android.permission.INTERNET',
      '    install permissions:',
      '      android.permission.INTERNET: granted=true',
      '    runtime permissions:',
      '      android.permission.CAMERA: granted=false',
      '      android.permission.RECORD_AUDIO: granted=true',
    ].join('\n');

    expect(parseUngrantedRuntimePermissions(dumpsys)).toEqual(['android.permission.CAMERA']);
  });

  it('tolerates trailing flags after granted=', () => {
    // Real dumpsys output often appends flags like `, flags=[ USER_SENSITIVE_WHEN_GRANTED ]`.
    const dumpsys = ['runtime permissions:', '  android.permission.CAMERA: granted=false, flags=[ RESTRICTED ]'].join(
      '\n',
    );
    expect(parseUngrantedRuntimePermissions(dumpsys)).toEqual(['android.permission.CAMERA']);
  });

  it('returns nothing when there is no runtime permissions block at all', () => {
    // Some packages declare no dangerous permissions — dumpsys omits the
    // section entirely rather than printing it empty.
    expect(parseUngrantedRuntimePermissions('Packages:\n  Package [com.example] (abc):\n')).toEqual([]);
  });

  it('returns nothing when every runtime permission is already granted', () => {
    const dumpsys = ['runtime permissions:', '  android.permission.CAMERA: granted=true'].join('\n');
    expect(parseUngrantedRuntimePermissions(dumpsys)).toEqual([]);
  });

  it('stops at the first non-permission line, not just end of output', () => {
    const dumpsys = [
      'runtime permissions:',
      '  android.permission.CAMERA: granted=false',
      '  User 0:',
      '    some unrelated per-user block',
    ].join('\n');
    expect(parseUngrantedRuntimePermissions(dumpsys)).toEqual(['android.permission.CAMERA']);
  });
});

/**
 * Best-effort permission granting — must never let one failed grant (or a
 * completely unreadable permission list) turn into a failed install, since
 * this always runs after a real, successful, verified install has already
 * happened. `runFn` is injected so this never has to mock `child_process`
 * itself (real `execFile` relies on a `util.promisify.custom` symbol a plain
 * mock wouldn't carry, which would silently break the `{stdout}` shape every
 * other function in this file also depends on).
 */
describe('grantRuntimePermissions', () => {
  it('grants every ungranted runtime permission and reports it', async () => {
    const dumpsys = ['runtime permissions:', '  android.permission.CAMERA: granted=false'].join('\n');
    const runFn = vi
      .fn()
      .mockResolvedValueOnce({ stdout: dumpsys, stderr: '' }) // dumpsys query
      .mockResolvedValueOnce({ stdout: '', stderr: '' }); // pm grant

    const result = await grantRuntimePermissions('adb', 'd1', 'com.wdiodemoapp', runFn);

    expect(result).toEqual({ granted: ['android.permission.CAMERA'], failed: [] });
    expect(runFn).toHaveBeenLastCalledWith(
      'adb',
      ['-s', 'd1', 'shell', 'pm', 'grant', 'com.wdiodemoapp', 'android.permission.CAMERA'],
      expect.anything(),
    );
  });

  it('records one permission failing to grant without stopping the rest', async () => {
    const dumpsys = [
      'runtime permissions:',
      '  android.permission.CAMERA: granted=false',
      '  android.permission.RECORD_AUDIO: granted=false',
    ].join('\n');
    const runFn = vi
      .fn()
      .mockResolvedValueOnce({ stdout: dumpsys, stderr: '' })
      .mockRejectedValueOnce(new Error('SecurityException'))
      .mockResolvedValueOnce({ stdout: '', stderr: '' });

    const result = await grantRuntimePermissions('adb', 'd1', 'com.wdiodemoapp', runFn);

    expect(result.granted).toEqual(['android.permission.RECORD_AUDIO']);
    expect(result.failed).toEqual(['android.permission.CAMERA']);
  });

  it('never throws when the permission list itself cannot be read', async () => {
    const runFn = vi.fn().mockRejectedValue(new Error('device offline'));

    await expect(grantRuntimePermissions('adb', 'd1', 'com.wdiodemoapp', runFn)).resolves.toEqual({
      granted: [],
      failed: [],
      listError: 'device offline',
    });
  });

  it('does nothing when there is nothing ungranted', async () => {
    const runFn = vi.fn().mockResolvedValue({ stdout: 'runtime permissions:\n  android.permission.CAMERA: granted=true', stderr: '' });

    const result = await grantRuntimePermissions('adb', 'd1', 'com.wdiodemoapp', runFn);

    expect(result).toEqual({ granted: [], failed: [] });
    expect(runFn).toHaveBeenCalledTimes(1); // only the dumpsys query, no grant attempted
  });
});

/**
 * A grant step that did not fully land is reported as a note on the `done`
 * target (the same `error`-on-`done` channel as an unverified install), so the
 * UI can show it instead of the install reading as fully provisioned.
 */
describe('describePermissionGrantNote', () => {
  it('is null when every permission was granted', () => {
    expect(describePermissionGrantNote({ failed: [] })).toBeNull();
  });

  it('names each permission that failed to grant', () => {
    const note = describePermissionGrantNote({ failed: ['android.permission.CAMERA', 'android.permission.RECORD_AUDIO'] });
    expect(note).toContain('2 runtime permission(s)');
    expect(note).toContain('android.permission.CAMERA, android.permission.RECORD_AUDIO');
  });

  it('says the grant step was skipped when the permission list could not be read', () => {
    expect(describePermissionGrantNote({ failed: [], listError: 'device offline' })).toContain('device offline');
  });
});

/**
 * The agent's own per-build cache — skips re-downloading a build it already
 * fetched. `cacheDir` is always a fresh temp directory here, never the real
 * per-agent cache: `ensureCachedBuild`'s default argument is the only thing
 * that ever points at `~/.mobile-hub-agent`, and no test exercises the default.
 */
describe('verifyPackageInstalled', () => {
  it('resolves null when the package manager reports an installed path', async () => {
    const runFn = vi.fn().mockResolvedValue({ stdout: 'package:/data/app/base.apk\n', stderr: '' });
    await expect(verifyPackageInstalled('adb', 'd1', 'com.example', runFn)).resolves.toBeNull();
  });

  it('throws when the package has no installed path — a real failed install', async () => {
    const runFn = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    await expect(verifyPackageInstalled('adb', 'd1', 'com.example', runFn)).rejects.toThrow(/did not take/);
  });

  it('returns a warning instead of throwing when the check itself cannot run (e.g. adb timeout)', async () => {
    // `pm install` already said Success; a verify that never ran is unknown,
    // not a failure — throwing here made runInstall report the target `error`.
    const runFn = vi.fn().mockRejectedValue(new Error('Command failed: timed out'));
    const warning = await verifyPackageInstalled('adb', 'd1', 'com.example', runFn);
    expect(warning).toMatch(/could not verify com\.example on d1: .*timed out/);
  });
});

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

  it('fetches directly from the build origin when one is given, skipping the hub entirely', async () => {
    const dir = freshCacheDir();
    const viaHubCalls: string[] = [];
    const directCalls: string[] = [];
    const bytes = Buffer.alloc(40, 3);
    const hub = {
      downloadArtifact: async (buildId: string) => {
        viaHubCalls.push(buildId);
      },
      downloadArtifactDirect: async (originUrl: string, destPath: string) => {
        directCalls.push(originUrl);
        fs.writeFileSync(destPath, bytes);
      },
    } as unknown as HubClient;

    const dest = await ensureCachedBuild(hub, 'b1', 40, () => {}, dir, 'https://origin.example/app.apk');

    expect(directCalls).toEqual(['https://origin.example/app.apk']);
    expect(viaHubCalls).toEqual([]);
    expect(fs.readFileSync(dest)).toEqual(bytes);
  });

  it('falls back to the via-hub download when the direct fetch fails', async () => {
    const dir = freshCacheDir();
    const viaHubCalls: string[] = [];
    const bytes = Buffer.alloc(40, 4);
    const hub = {
      downloadArtifact: async (buildId: string, destPath: string) => {
        viaHubCalls.push(buildId);
        fs.writeFileSync(destPath, bytes);
      },
      downloadArtifactDirect: async () => {
        throw new Error('origin unreachable from this agent');
      },
    } as unknown as HubClient;

    const dest = await ensureCachedBuild(hub, 'b1', 40, () => {}, dir, 'https://origin.example/app.apk');

    expect(viaHubCalls).toEqual(['b1']);
    expect(fs.readFileSync(dest)).toEqual(bytes);
  });

  it('never attempts a direct fetch for a file:// origin — that path is on the hub, not this agent', async () => {
    const dir = freshCacheDir();
    const viaHubCalls: string[] = [];
    const directCalls: string[] = [];
    const hub = {
      downloadArtifact: async (buildId: string, destPath: string) => {
        viaHubCalls.push(buildId);
        fs.writeFileSync(destPath, Buffer.alloc(40));
      },
      downloadArtifactDirect: async (originUrl: string) => {
        directCalls.push(originUrl);
      },
    } as unknown as HubClient;

    await ensureCachedBuild(hub, 'b1', 40, () => {}, dir, 'file:///C:/hub-builds/b1.apk');

    expect(directCalls).toEqual([]);
    expect(viaHubCalls).toEqual(['b1']);
  });
});
