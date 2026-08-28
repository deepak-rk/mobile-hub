export interface Build {
  _id: string;
  project: string;
  platform: 'android' | 'ios';
  version: string;
  artifactUrl: string;
  /** Where the artifact lives on the host's disk. Null before it's fetched, and again once purged. */
  artifactPath: string | null;
  sizeBytes: number | null;
  checksum: string | null;
  /** Matches backend/src/modules/builds/build.model.ts — 'purged' is real: the retention GC reclaims disk space. */
  status: 'downloading' | 'validating' | 'corrupt' | 'ready' | 'purged';
  integrityValidatedAt: string | null;
  fetchedAt: string | null;
  /** Set when the retention GC removes this build's artifact from disk. */
  purgedAt: string | null;
  createdAt: string;
}
