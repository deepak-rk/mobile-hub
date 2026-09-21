import { BuildProviderName } from '../../config/org-config.schema';
import { IBuild, IBuildConstraints, IBuildProvenance } from './build.model';

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
  /**
   * Where this build came from, when the provider actually knows. Only
   * `url-build-provider.ts` populates any of this today (`sourceUrl`, and
   * `sourceTimestamp` when the source reports one) — the CI-metadata fields
   * have no current source and stay absent rather than guessed at.
   */
  provenance?: IBuildProvenance;
}

export interface BuildListContext {
  project: string;
  platform: IBuild['platform'];
}

/** One entry in a `listBuilds()` page — provider-neutral, so callers don't branch on provider name. */
export interface BuildListItem {
  version: string;
  artifactUrl?: string;
  provenance?: IBuildProvenance;
}

export interface BuildListPage {
  items: BuildListItem[];
  /** Opaque; pass back on the next call to continue. Null when there is no further page. */
  nextCursor: string | null;
}

export interface BuildListPagination {
  cursor?: string;
  limit?: number;
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
  /**
   * Browse builds available at the source, without fetching one. Paginated —
   * a real registry (Nexus, S3, a CI API) can hold far more versions than a
   * caller wants in one response. A provider with no browsable concept of
   * "available builds" (e.g. a single direct URL) should reject with a clear,
   * specific error rather than fabricate a list.
   */
  listBuilds(ctx: BuildListContext, pagination?: BuildListPagination): Promise<BuildListPage>;
}
