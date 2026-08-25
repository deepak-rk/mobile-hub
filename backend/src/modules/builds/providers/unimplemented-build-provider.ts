import { BuildProviderName } from '../../../config/org-config.schema';
import { BuildFetchContext, BuildFetchResult, BuildProvider } from '../build-provider';

/**
 * Placeholder for providers not yet implemented (nexus/s3/webhook). Exists so
 * selecting one via config fails with a clear, specific error at fetch time
 * rather than a missing-registry-entry crash — and so the adapter registry
 * already has a slot for each provider named in root CLAUDE.md §11.
 */
export class UnimplementedBuildProvider implements BuildProvider {
  constructor(readonly name: BuildProviderName) {}

  fetch(_ctx: BuildFetchContext, _destPath: string): Promise<BuildFetchResult> {
    return Promise.reject(new Error(`BuildProvider '${this.name}' is not implemented yet`));
  }
}
