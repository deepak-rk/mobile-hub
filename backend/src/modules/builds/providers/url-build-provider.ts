import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { BuildFetchContext, BuildFetchProgress, BuildFetchResult, BuildProvider } from '../build-provider';

const FETCH_TIMEOUT_MS = 60_000;

export class UrlBuildProvider implements BuildProvider {
  readonly name = 'url' as const;

  async fetch(ctx: BuildFetchContext, destPath: string, onProgress?: BuildFetchProgress): Promise<BuildFetchResult> {
    if (!ctx.artifactUrl) {
      throw new Error("BuildProvider 'url' requires artifactUrl");
    }

    fs.mkdirSync(path.dirname(destPath), { recursive: true });

    // `file://` is accepted alongside real http(s) URLs so a build already
    // sitting on this host's disk (e.g. fetched by a sibling automation repo)
    // can be registered as a real Build for local verification, without a
    // dedicated local-file provider. Node's own `fetch` doesn't support this
    // scheme, so it's handled separately via a plain copy.
    if (ctx.artifactUrl.startsWith('file://')) {
      const sourcePath = fileURLToPath(ctx.artifactUrl);
      // A local copy has no meaningful transfer curve to report; it either
      // completes or throws.
      await fs.promises.copyFile(sourcePath, destPath);
      const { size } = fs.statSync(destPath);
      onProgress?.(size, size);
      return { sourceUrl: ctx.artifactUrl, sizeBytes: size };
    }

    const res = await globalThis.fetch(ctx.artifactUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok || !res.body) {
      throw new Error(`Failed to fetch build artifact: ${res.status} ${res.statusText}`);
    }

    const header = res.headers.get('content-length');
    const totalBytes = header ? Number(header) : null;
    let downloadedBytes = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        downloadedBytes += chunk.length;
        onProgress?.(downloadedBytes, Number.isFinite(totalBytes) ? totalBytes : null);
        callback(null, chunk);
      },
    });

    await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(destPath));

    const { size } = fs.statSync(destPath);
    return { sourceUrl: ctx.artifactUrl, sizeBytes: size };
  }
}
