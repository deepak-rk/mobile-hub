import { Schema, model, Document } from 'mongoose';
import { randomUUID } from 'crypto';

export interface IStreamSession extends Document {
  machineId: string;
  deviceUdid: string;
  protocol: 'mjpeg' | 'h264';
  captureStatus: 'starting' | 'active' | 'stopped';
  capturePid: number | null;
  retryKey: string;
  viewerIds: string[];
  viewerCount: number;
  /** iOS simulators are capped per host (xcrun drops frames past 8). */
  isSimulator: boolean;
  startedAt: Date;
  lastViewerJoinedAt: Date | null;
}

const streamSessionSchema = new Schema<IStreamSession>(
  {
    machineId: { type: String, required: true },
    deviceUdid: { type: String, required: true },
    protocol: { type: String, enum: ['mjpeg', 'h264'], required: true },
    captureStatus: {
      type: String,
      enum: ['starting', 'active', 'stopped'],
      default: 'starting',
    },
    capturePid: { type: Number, default: null },
    retryKey: { type: String, default: () => randomUUID() },
    viewerIds: { type: [String], default: [] },
    viewerCount: { type: Number, default: 0 },
    isSimulator: { type: Boolean, default: false },
    startedAt: { type: Date, default: Date.now },
    lastViewerJoinedAt: { type: Date, default: null },
  },
  { timestamps: false },
);

// One capture process per (machineId, deviceUdid, protocol)
streamSessionSchema.index({ machineId: 1, deviceUdid: 1, protocol: 1 }, { unique: true });

export const StreamSession = model<IStreamSession>('StreamSession', streamSessionSchema);
