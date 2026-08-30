import { BuildProviderName } from '../../config/org-config.schema';
import { IBuild } from './build.model';

export interface BuildFetchContext {
  project: string;
  platform: IBuild['platform'];
  version: string;
  /** Required for the 'url' provider; ignored by the others. */
  artifactUrl?: string;
}

export interface BuildFetchResult {
  sourceUrl: string;
  sizeBytes: number;
}

/**
 * One adapter per build source (root CLAUDE.md §11) — adding a new provider
 * means implementing this interface, not touching builds.service.ts.
 */
/**
 * Called as bytes land. `totalBytes` is null when the source doesn't declare a
 * size, in which case callers must show indeterminate progress rather than
 * inventing a percentage. Providers should call this at whatever granularity
 * is natural; throttling is the caller's job.
 */
export type BuildFetchProgress = (downloadedBytes: number, totalBytes: number | null) => void;

export interface BuildProvider {
  readonly name: BuildProviderName;
  fetch(ctx: BuildFetchContext, destPath: string, onProgress?: BuildFetchProgress): Promise<BuildFetchResult>;
}
