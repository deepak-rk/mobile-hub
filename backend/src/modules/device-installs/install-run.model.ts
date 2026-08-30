import { Schema, model, Document, Types } from 'mongoose';

export type InstallTargetStatus = 'queued' | 'downloading' | 'installing' | 'done' | 'error';

export interface IInstallTarget {
  deviceUdid: string;
  machineId: string;
  status: InstallTargetStatus;
  /** 0-100, download progress toward the device — installing itself is fast and not sub-divided. */
  progress: number;
  error: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
}

export interface IInstallRun extends Document {
  buildId: Types.ObjectId;
  project: string;
  platform: 'android' | 'ios';
  // One embedded record per targeted device — same precedent as
  // ExecutionRun.stages: independent status/progress/error per target, so
  // one device failing doesn't block or hide the others, and any single
  // target can be re-driven by triggering a fresh InstallRun against it
  // without re-touching devices that already succeeded.
  targets: IInstallTarget[];
  triggeredBy: string;
  createdAt: Date;
  updatedAt: Date;
}

const installTargetSchema = new Schema<IInstallTarget>(
  {
    deviceUdid: { type: String, required: true },
    machineId: { type: String, required: true },
    status: { type: String, enum: ['queued', 'downloading', 'installing', 'done', 'error'], default: 'queued' },
    progress: { type: Number, default: 0 },
    error: { type: String, default: null },
    startedAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },
  },
  { _id: false },
);

/**
 * Deliberately holds NO device lock while a target is in flight — a direct,
 * explicit user decision (this session) overriding execution's own
 * lock-for-the-duration precedent (execution.service.ts). The accepted
 * tradeoff: an install can race a live execution run on the same device
 * (e.g. an install landing mid-test-run). Revisit if that turns out to
 * cause real pain; until then this is intentional, not an oversight.
 */
const installRunSchema = new Schema<IInstallRun>(
  {
    buildId: { type: Schema.Types.ObjectId, ref: 'Build', required: true, index: true },
    project: { type: String, required: true, index: true },
    platform: { type: String, enum: ['android', 'ios'], required: true },
    targets: { type: [installTargetSchema], default: [] },
    triggeredBy: { type: String, required: true },
  },
  { timestamps: true },
);

export const InstallRun = model<IInstallRun>('InstallRun', installRunSchema);
