import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { BuildFetchContext, BuildFetchResult, BuildProvider } from '../build-provider';

const FETCH_TIMEOUT_MS = 60_000;

export class UrlBuildProvider implements BuildProvider {
  readonly name = 'url' as const;

  async fetch(ctx: BuildFetchContext, destPath: string): Promise<BuildFetchResult> {
    if (!ctx.artifactUrl) {
      throw new Error("BuildProvider 'url' requires artifactUrl");
    }

    const res = await globalThis.fetch(ctx.artifactUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok || !res.body) {
      throw new Error(`Failed to fetch build artifact: ${res.status} ${res.statusText}`);
    }

    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(destPath));

    const { size } = fs.statSync(destPath);
    return { sourceUrl: ctx.artifactUrl, sizeBytes: size };
  }
}
