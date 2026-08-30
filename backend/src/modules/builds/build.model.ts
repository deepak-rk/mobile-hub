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

export const Build = model<IBuild>('Build', buildSchema);
