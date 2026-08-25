import { Schema, model, Document } from 'mongoose';

export interface DeviceLock {
  heldBy: string;
  sessionId: string;
  acquiredAt: Date;
  reason?: string;
}

// Omit 'model' — the Document base type declares a `model()` method with the
// same name, which collides with our `model` field (device model name, e.g. "Pixel 7").
export interface IDevice extends Omit<Document, 'model'> {
  udid: string;
  machineId: string;
  platform: 'android' | 'ios';
  name: string;
  osVersion: string;
  model: string;
  connectionType: 'usb' | 'network' | 'simulator' | 'emulator';
  status: 'idle' | 'smoke' | 'in-use' | 'offline' | 'unreachable';
  lock: DeviceLock | null;
  isLocallyReachable: boolean;
  lastSeenAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const deviceSchema = new Schema<IDevice>(
  {
    udid: { type: String, required: true },
    machineId: { type: String, required: true, index: true },
    platform: { type: String, enum: ['android', 'ios'], required: true },
    name: { type: String, required: true },
    osVersion: { type: String, required: true },
    model: { type: String, required: true },
    connectionType: {
      type: String,
      enum: ['usb', 'network', 'simulator', 'emulator'],
      required: true,
    },
    status: {
      type: String,
      enum: ['idle', 'smoke', 'in-use', 'offline', 'unreachable'],
      default: 'idle',
    },
    lock: {
      type: {
        heldBy: { type: String, required: true },
        sessionId: { type: String, required: true },
        acquiredAt: { type: Date, required: true },
        reason: { type: String },
      },
      default: null,
    },
    isLocallyReachable: { type: Boolean, default: true },
    lastSeenAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

// Unique per host — same UDID can exist on different hosts
deviceSchema.index({ machineId: 1, udid: 1 }, { unique: true });

export const Device = model<IDevice>('Device', deviceSchema);
