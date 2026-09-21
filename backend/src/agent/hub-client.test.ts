import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { HubClient } from './hub-client';

/**
 * `downloadArtifact`'s byte counting, which exists because the progress it
 * feeds was previously a lie: the response was piped straight to disk with no
 * counting, so `InstallTarget.progress` only ever carried 0 and 100 while the
 * UI rendered a determinate bar from it.
 */
afterEach(() => {
  vi.restoreAllMocks();
});

function mockArtifactResponse(body: Buffer, headers: Record<string, string>) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      body: Readable.toWeb(Readable.from([body.subarray(0, 40), body.subarray(40)])),
      headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    }),
  );
}

describe('HubClient.downloadArtifact', () => {
  const dest = path.join(os.tmpdir(), `mh-artifact-${Date.now()}.bin`);

  afterEach(() => {
    fs.rmSync(dest, { force: true });
  });

  it('writes the artifact and reports cumulative bytes against the total', async () => {
    const body = Buffer.alloc(100, 7);
    mockArtifactResponse(body, { 'content-length': '100' });
    const seen: Array<[number, number | null]> = [];

    await new HubClient('http://hub', 'tok').downloadArtifact('build-1', dest, (got, total) =>
      seen.push([got, total]),
    );

    expect(fs.statSync(dest).size).toBe(100);
    // Cumulative, not per-chunk, and monotonic — a bar that goes backwards is
    // as wrong as one that never moves.
    expect(seen).toEqual([
      [40, 100],
      [100, 100],
    ]);
  });

  it('reports a null total when the server sends no Content-Length', async () => {
    // The caller must then leave progress alone rather than inventing a
    // percentage it cannot compute.
    mockArtifactResponse(Buffer.alloc(60, 1), {});
    const totals: Array<number | null> = [];

    await new HubClient('http://hub').downloadArtifact('build-1', dest, (_got, total) => totals.push(total));

    expect(totals.every((t) => t === null)).toBe(true);
    expect(fs.statSync(dest).size).toBe(60);
  });

  it('still downloads correctly with no progress callback supplied', async () => {
    mockArtifactResponse(Buffer.alloc(75, 3), { 'content-length': '75' });

    await new HubClient('http://hub').downloadArtifact('build-1', dest);

    expect(fs.statSync(dest).size).toBe(75);
  });

  it('rejects a truncated download and leaves no file at the destination', async () => {
    // Server claims 100 bytes but the body only actually carries 40 — the
    // shape of a connection that closes early without erroring the stream.
    mockArtifactResponse(Buffer.alloc(40, 5), { 'content-length': '100' });

    await expect(new HubClient('http://hub').downloadArtifact('build-1', dest)).rejects.toThrow(/truncated/i);

    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.existsSync(`${dest}.part`)).toBe(false);
  });

  it('rejects an empty download and leaves no file at the destination', async () => {
    mockArtifactResponse(Buffer.alloc(0), { 'content-length': '0' });

    await expect(new HubClient('http://hub').downloadArtifact('build-1', dest)).rejects.toThrow(/empty/i);

    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.existsSync(`${dest}.part`)).toBe(false);
  });
});

/**
 * `downloadArtifactDirect` shares its integrity gate with `downloadArtifact`
 * above (`streamToFileWithIntegrityGate`) — these tests exist to confirm that
 * sharing actually holds, not to re-prove byte counting from scratch.
 */
describe('HubClient.downloadArtifactDirect', () => {
  const dest = path.join(os.tmpdir(), `mh-artifact-direct-${Date.now()}.bin`);

  afterEach(() => {
    fs.rmSync(dest, { force: true });
  });

  it('fetches straight from the given origin URL, no Authorization header', async () => {
    const body = Buffer.alloc(50, 9);
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      body: Readable.toWeb(Readable.from([body])),
      headers: { get: (k: string) => (k.toLowerCase() === 'content-length' ? '50' : null) },
    });
    vi.stubGlobal('fetch', fetchSpy);

    await new HubClient('http://hub', 'tok').downloadArtifactDirect('https://origin.example/app.apk', dest);

    expect(fs.statSync(dest).size).toBe(50);
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://origin.example/app.apk',
      expect.objectContaining({ signal: expect.anything() as AbortSignal }),
    );
    // No agent token sent to an external origin — it isn't this hub.
    const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit | undefined];
    expect(opts?.headers).toBeUndefined();
  });

  it('rejects a truncated direct download the same way the via-hub path does', async () => {
    mockArtifactResponse(Buffer.alloc(10, 1), { 'content-length': '100' });

    await expect(
      new HubClient('http://hub').downloadArtifactDirect('https://origin.example/app.apk', dest),
    ).rejects.toThrow(/truncated/i);

    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.existsSync(`${dest}.part`)).toBe(false);
  });
});
