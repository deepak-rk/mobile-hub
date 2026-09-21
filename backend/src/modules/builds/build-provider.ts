import { BuildProviderName } from '../../config/org-config.schema';
import { IBuild, IBuildConstraints } from './build.model';

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
  /**
   * Install compatibility info, when a provider actually has one to report.
   * No current provider populates this — it exists so a future one (a CI
   * artifact API that carries min-OS/arch/feature-flag metadata, say) has
   * somewhere to put it without a `builds.service.ts` change.
   */
  constraints?: IBuildConstraints;
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
