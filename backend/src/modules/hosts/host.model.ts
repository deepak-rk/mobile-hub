import { Schema, model, Document } from 'mongoose';

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
    lastHeartbeatAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

export const Host = model<IHost>('MachineHost', hostSchema);
