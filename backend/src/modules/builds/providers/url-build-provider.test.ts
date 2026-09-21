import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { UrlBuildProvider } from './url-build-provider';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-url-provider-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('UrlBuildProvider.fetch', () => {
  it('populates sourceUrl and sourceTimestamp from a Last-Modified header over http(s)', async () => {
    const bytes = Buffer.from('a real fake artifact');
    const lastModified = 'Tue, 01 Sep 2026 00:00:00 GMT';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(bytes, {
          status: 200,
          headers: { 'content-length': String(bytes.length), 'last-modified': lastModified },
        }),
      ),
    );

    const provider = new UrlBuildProvider();
    const destPath = path.join(tmpDir, 'out.apk');
    const result = await provider.fetch(
      { project: 'p', platform: 'android', version: '1', artifactUrl: 'https://example.com/a.apk' },
      destPath,
    );

    expect(result.provenance?.sourceUrl).toBe('https://example.com/a.apk');
    expect(result.provenance?.sourceTimestamp).toEqual(new Date(lastModified));
    // Fields no provider can know from an http fetch stay null, not guessed at.
    expect(result.provenance?.branch).toBeNull();
    expect(result.provenance?.commitSha).toBeNull();
  });

  it('leaves sourceTimestamp null when the response has no Last-Modified header', async () => {
    const bytes = Buffer.from('a real fake artifact');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } })),
    );

    const provider = new UrlBuildProvider();
    const destPath = path.join(tmpDir, 'out.apk');
    const result = await provider.fetch(
      { project: 'p', platform: 'android', version: '1', artifactUrl: 'https://example.com/a.apk' },
      destPath,
    );

    expect(result.provenance?.sourceTimestamp).toBeNull();
  });

  it('populates sourceTimestamp from the source file mtime for a file:// URL', async () => {
    const sourcePath = path.join(tmpDir, 'source.apk');
    fs.writeFileSync(sourcePath, Buffer.from('a real fake artifact'));
    const mtime = new Date('2026-08-15T12:00:00.000Z');
    fs.utimesSync(sourcePath, mtime, mtime);

    const provider = new UrlBuildProvider();
    const destPath = path.join(tmpDir, 'out.apk');
    const sourceUrl = pathToFileURL(sourcePath).toString();
    const result = await provider.fetch({ project: 'p', platform: 'android', version: '1', artifactUrl: sourceUrl }, destPath);

    expect(result.provenance?.sourceUrl).toBe(sourceUrl);
    expect(result.provenance?.sourceTimestamp).toEqual(mtime);
  });
});

describe('UrlBuildProvider.listBuilds', () => {
  it('rejects — a direct URL has nothing to browse', async () => {
    const provider = new UrlBuildProvider();
    await expect(provider.listBuilds({ project: 'p', platform: 'android' })).rejects.toThrow(/does not support listing/i);
  });
});
