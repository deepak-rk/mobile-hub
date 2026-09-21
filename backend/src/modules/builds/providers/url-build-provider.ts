import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import {
  BuildFetchContext,
  BuildFetchProgress,
  BuildFetchResult,
  BuildListContext,
  BuildListPage,
  BuildListPagination,
  BuildProvider,
} from '../build-provider';
import { IBuildProvenance } from '../build.model';

const FETCH_TIMEOUT_MS = 60_000;

/** Every field this provider can never know, filled in around whatever the caller supplies. */
function provenanceFrom(fields: Partial<IBuildProvenance>): IBuildProvenance {
  return {
    buildNumber: null,
    branch: null,
    commitSha: null,
    commitTitle: null,
    sourceTimestamp: null,
    sourceUrl: null,
    ...fields,
  };
}

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
      const stat = fs.statSync(destPath);
      onProgress?.(stat.size, stat.size);
      return {
        sourceUrl: ctx.artifactUrl,
        sizeBytes: stat.size,
        // The copy's own mtime is just "when we fetched it", not a real
        // source timestamp — the source file's own mtime is what's genuine.
        provenance: provenanceFrom({ sourceUrl: ctx.artifactUrl, sourceTimestamp: fs.statSync(sourcePath).mtime }),
      };
    }

    const res = await globalThis.fetch(ctx.artifactUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok || !res.body) {
      throw new Error(`Failed to fetch build artifact: ${res.status} ${res.statusText}`);
    }

    const header = res.headers.get('content-length');
    const totalBytes = header ? Number(header) : null;
    // Best-effort only: an absent or unparseable Last-Modified must not fail
    // a fetch whose actual job (getting the bytes) already succeeded.
    const lastModified = res.headers.get('last-modified');
    const sourceTimestamp = lastModified && !Number.isNaN(Date.parse(lastModified)) ? new Date(lastModified) : null;
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
    return {
      sourceUrl: ctx.artifactUrl,
      sizeBytes: size,
      provenance: provenanceFrom({ sourceUrl: ctx.artifactUrl, sourceTimestamp }),
    };
  }

  /**
   * A direct URL is supplied per-fetch, not discovered — there is no registry
   * behind it to browse. Rejecting (rather than returning an empty page) is
   * the honest signal: "zero builds available" and "this provider can't list
   * at all" are different facts, and only the second is true here.
   */
  listBuilds(_ctx: BuildListContext, _pagination?: BuildListPagination): Promise<BuildListPage> {
    return Promise.reject(
      new Error("BuildProvider 'url' does not support listing — it fetches one artifactUrl at a time"),
    );
  }
}
