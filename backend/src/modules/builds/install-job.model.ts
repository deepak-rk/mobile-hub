import { Schema, model, Document, Types } from 'mongoose';

/**
 * @deprecated Written by nothing, read by nothing — dead code as of 2026-08-29.
 *
 * Specified in docs/modules/builds.md to track an artifact **download to the
 * hub** with ~1s progress updates pushed over a WebSocket. That progress
 * pipeline was never built; `triggerBuildFetch` reports status on the `Build`
 * record instead.
 *
 * **Do not confuse this with `InstallRun`** (modules/device-installs), which is
 * live, and tracks installing a ready artifact **onto devices**. Two things
 * called "install job" is exactly how a future change wires progress to the
 * wrong collection — the reason this warning exists rather than a silent stub.
 *
 * Either implement the download-progress pipeline here or delete this model;
 * do not extend it to mean device installs.
 */
export interface IInstallJob extends Document {
  buildId: Types.ObjectId;
  project: string;
  platform: 'android' | 'ios';
  version: string;
  status: 'queued' | 'pending' | 'downloading' | 'validating' | 'complete' | 'error';
  progress: number;
  sizeBytes: number | null;
  downloadedBytes: number;
  error: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
}

const installJobSchema = new Schema<IInstallJob>(
  {
    buildId: { type: Schema.Types.ObjectId, ref: 'Build', required: true, index: true },
    project: { type: String, required: true },
    platform: { type: String, enum: ['android', 'ios'], required: true },
    version: { type: String, required: true },
    status: {
      type: String,
      enum: ['queued', 'pending', 'downloading', 'validating', 'complete', 'error'],
      default: 'queued',
    },
    progress: { type: Number, default: 0, min: 0, max: 100 },
    sizeBytes: { type: Number, default: null },
    downloadedBytes: { type: Number, default: 0 },
    error: { type: String, default: null },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

export const InstallJob = model<IInstallJob>('InstallJob', installJobSchema);
