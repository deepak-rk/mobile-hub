/**
 * Install compatibility info a build provider *can* report — no current
 * provider populates this. Null (the whole object) is the common case, not a
 * loading state; render conditionally, never as an empty "N/A" row.
 */
export interface BuildConstraints {
  minOsVersion: string | null;
  architecture: string | null;
  features: string[];
}

export interface Build {
  _id: string;
  project: string;
  platform: 'android' | 'ios';
  version: string;
  artifactUrl: string;
  /** Where the artifact lives on the host's disk. Null before it's fetched, and again once purged. */
  artifactPath: string | null;
  sizeBytes: number | null;
  /**
   * Bytes fetched so far while `status === 'downloading'`; meaningless once
   * ready. Optional because a build recorded before this field existed
   * genuinely has no value — absent is the truthful representation, not 0.
   */
  downloadedBytes?: number;
  checksum: string | null;
  /** Matches backend/src/modules/builds/build.model.ts — 'purged' is real: the retention GC reclaims disk space. */
  status: 'downloading' | 'validating' | 'corrupt' | 'ready' | 'purged';
  integrityValidatedAt: string | null;
  fetchedAt: string | null;
  /** Set when the retention GC removes this build's artifact from disk. */
  purgedAt: string | null;
  /** Null when the provider that fetched this build didn't report any. */
  constraints: BuildConstraints | null;
  createdAt: string;
}
