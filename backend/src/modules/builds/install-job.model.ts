import { Schema, model, Document, Types } from 'mongoose';

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
