import { Schema, model, Document } from 'mongoose';

export interface IBuild extends Document {
  project: string;
  platform: 'android' | 'ios';
  version: string;
  artifactUrl: string;
  artifactPath: string | null;
  sizeBytes: number | null;
  /**
   * Bytes written so far while `status === 'downloading'`.
   *
   * Lives on `Build` rather than reviving the specified-but-dead `InstallJob`
   * model: one object per build is simpler than two, and `InstallJob` is
   * already easy to confuse with `InstallRun` (device installs). Meaningless
   * once the build is `ready` — read it only against `sizeBytes` mid-download.
   */
  downloadedBytes: number;
  checksum: string | null;
  checksumAlgorithm: 'sha256';
  status: 'downloading' | 'validating' | 'corrupt' | 'ready' | 'purged';
  integrityValidatedAt: Date | null;
  fetchedAt: Date | null;
  /** Set when the retention GC removes this build's artifact from disk. */
  purgedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const buildSchema = new Schema<IBuild>(
  {
    project: { type: String, required: true, index: true },
    platform: { type: String, enum: ['android', 'ios'], required: true },
    version: { type: String, required: true },
    artifactUrl: { type: String, required: true },
    artifactPath: { type: String, default: null },
    sizeBytes: { type: Number, default: null },
    downloadedBytes: { type: Number, default: 0 },
    checksum: { type: String, default: null },
    checksumAlgorithm: { type: String, enum: ['sha256'], default: 'sha256' },
    status: {
      type: String,
      enum: ['downloading', 'validating', 'corrupt', 'ready', 'purged'],
      default: 'downloading',
    },
    integrityValidatedAt: { type: Date, default: null },
    fetchedAt: { type: Date, default: null },
    purgedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

buildSchema.index({ project: 1, platform: 1, version: 1 });

/**
 * At most one in-flight fetch per (project, platform, version).
 *
 * This is what makes `startBuildFetch`'s upsert genuinely atomic rather than
 * merely usually-atomic: MongoDB only guarantees that concurrent upserts can't
 * both insert when a unique index covers the query fields. Without it two
 * requests arriving in the same tick would each download the whole artifact
 * and leave duplicate rows for one logical build.
 *
 * Partial, so it constrains only rows that are actually being fetched right
 * now. A `corrupt` row must not block a retry, and repeated `ready` rows for a
 * version are a legitimate re-fetch, so neither is covered.
 *
 * Note `validating` is deliberately outside the filter: `partialFilterExpression`
 * is restricted to simple predicates, and covering both states would need `$in`
 * — supported only on newer servers. The unguarded window is the checksum of an
 * already-downloaded local file, so the worst case is one redundant download,
 * never a corrupted artifact.
 */
buildSchema.index(
  { project: 1, platform: 1, version: 1 },
  {
    unique: true,
    partialFilterExpression: { status: 'downloading' },
    name: 'one_inflight_fetch_per_version',
  },
);

export const Build = model<IBuild>('Build', buildSchema);
