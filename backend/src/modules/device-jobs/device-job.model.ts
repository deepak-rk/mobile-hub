import { Schema, model, Document, Types } from 'mongoose';
import type { DeviceAction } from '../../common/device-actions';

/**
 * One action sent to one phone (`common/device-actions.ts`), run by the agent
 * on the phone's host. A durable record rather than an in-memory request, the
 * shape a reference farm arrived at after losing results:
 *
 *  - the result route is keyed on this record's id, so a report always finds
 *    its job, even after a hub restart;
 *  - a late result is still accepted (a job past its timeout that then
 *    finishes records what happened, marked `late`), never dropped;
 *  - records expire after 24 h.
 */
export const DEVICE_JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'timed_out', 'interrupted'] as const;
export type DeviceJobStatus = (typeof DEVICE_JOB_STATUSES)[number];
export const FINAL_JOB_STATUSES: DeviceJobStatus[] = ['succeeded', 'failed'];

export interface IDeviceJob extends Document {
  _id: Types.ObjectId;
  machineId: string;
  deviceUdid: string;
  action: DeviceAction;
  status: DeviceJobStatus;
  requestedBy: string;
  idempotencyKey: string | null;
  /** What the agent saw, e.g. a rotation read back from the display. */
  output: string | null;
  error: string | null;
  /** Reported after the job had already timed out or been interrupted. */
  late: boolean;
  startedAt: Date | null;
  endedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const deviceJobSchema = new Schema<IDeviceJob>(
  {
    machineId: { type: String, required: true },
    deviceUdid: { type: String, required: true },
    action: { type: Schema.Types.Mixed, required: true },
    status: { type: String, enum: DEVICE_JOB_STATUSES, default: 'queued' },
    requestedBy: { type: String, required: true },
    idempotencyKey: { type: String, default: null },
    output: { type: String, default: null },
    error: { type: String, default: null },
    late: { type: Boolean, default: false },
    startedAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: () => new Date(Date.now() + DAY_MS) },
  },
  { timestamps: true },
);

// The agent's claim: oldest queued job for its host.
deviceJobSchema.index({ machineId: 1, status: 1, createdAt: 1 });
deviceJobSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
// A retried request with the same Idempotency-Key gets the same job.
deviceJobSchema.index(
  { requestedBy: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
);

export const DeviceJob = model<IDeviceJob>('DeviceJob', deviceJobSchema);
