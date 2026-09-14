import { Schema, model, Document } from 'mongoose';

export interface IHostDiagnostics {
  diskFreeBytes: number | null;
  diskTotalBytes: number | null;
  nodeVersion: string | null;
}

export interface IHost extends Document {
  machineId: string;
  hostname: string;
  os: 'darwin' | 'linux' | 'win32';
  agentVersion: string;
  status: 'online' | 'offline' | 'degraded';
  capabilities: {
    maxDevices: number;
    androidSupport: boolean;
    iosSupport: boolean;
  };
  /**
   * Best-effort operational stats reported alongside a heartbeat. Null (the
   * whole object, or any one field) rather than zero when unknown — an
   * agent that predates this field, or a `statfs` call that failed on some
   * unusual filesystem, must not report "0 bytes free" as if that were a
   * measured fact.
   */
  diagnostics: IHostDiagnostics | null;
  lastHeartbeatAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const hostSchema = new Schema<IHost>(
  {
    machineId: { type: String, required: true, unique: true, index: true },
    hostname: { type: String, required: true },
    os: { type: String, enum: ['darwin', 'linux', 'win32'], required: true },
    agentVersion: { type: String, required: true },
    status: { type: String, enum: ['online', 'offline', 'degraded'], default: 'online' },
    capabilities: {
      maxDevices: { type: Number, default: 0 },
      androidSupport: { type: Boolean, default: false },
      iosSupport: { type: Boolean, default: false },
    },
    diagnostics: {
      type: {
        diskFreeBytes: { type: Number, default: null },
        diskTotalBytes: { type: Number, default: null },
        nodeVersion: { type: String, default: null },
      },
      default: null,
    },
    lastHeartbeatAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

export const Host = model<IHost>('MachineHost', hostSchema);
