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
  /** Port of this device's Appium server, assigned once and then stable. */
  appiumPort: number | null;
  /**
   * Set by the hub when it needs an agent-hosted Appium endpoint for this
   * device (`appium.remoteEnabled`) and doesn't have a fresh one yet — the
   * agent discovers this on its next heartbeat, starts (or adopts) its own
   * local server, and reports the endpoint back, clearing this field.
   * Null once satisfied or never requested.
   */
  remoteAppiumRequestedAt: Date | null;
  /**
   * The agent-reported endpoint for this device's Appium server, once it
   * exists. Distinct from `appiumPort` (which is where the *hub* would spawn
   * one for its own, hub-local path) — this is always agent-owned.
   */
  remoteAppium: { host: string; port: number; readyAt: Date } | null;
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
    appiumPort: { type: Number, default: null },
    remoteAppiumRequestedAt: { type: Date, default: null },
    remoteAppium: {
      type: {
        host: { type: String, required: true },
        port: { type: Number, required: true },
        readyAt: { type: Date, required: true },
      },
      default: null,
    },
    lastSeenAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

// Unique per host — same UDID can exist on different hosts
deviceSchema.index({ machineId: 1, udid: 1 }, { unique: true });

export const Device = model<IDevice>('Device', deviceSchema);
