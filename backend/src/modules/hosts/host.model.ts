import { Schema, model, Document } from 'mongoose';

export interface IHostDiagnostics {
  diskFreeBytes: number | null;
  diskTotalBytes: number | null;
  nodeVersion: string | null;
  cpuPercent: number | null;
  cpuCount: number | null;
  memTotalBytes: number | null;
  memFreeBytes: number | null;
}

export interface IHost extends Document {
  machineId: string;
  hostname: string;
  os: 'darwin' | 'linux' | 'win32';
  agentVersion: string;
  /** The hub <-> agent contract version the agent reported (`common/agent-protocol.ts`); null for an agent that predates it. */
  protocolVersion: number | null;
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
  /**
   * Set when an admin removed this host from the lab. A tombstone rather than
   * a delete: a deleted host re-registered itself on its next heartbeat, so
   * removal never stuck. Its heartbeats, syncs and job polls are refused
   * until an admin unblocks it.
   */
  blocked: { at: Date; by: string; reason: string | null } | null;
  /**
   * Hash of the OS machine id of the machine heartbeating under this id, or
   * null for an agent that does not send one. Lets the hub refuse a second
   * machine given the same MACHINE_ID instead of letting the two overwrite
   * each other's device lists.
   */
  fingerprint: string | null;
  /** The last time another machine was refused this id, kept for the Hosts page; cleared after 5 minutes without one. */
  idConflict: { at: Date; hostname: string | null } | null;
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
    protocolVersion: { type: Number, default: null },
    status: { type: String, enum: ['online', 'offline', 'degraded'], default: 'online' },
    capabilities: {
      maxDevices: { type: Number, default: 0 },
      androidSupport: { type: Boolean, default: false },
      iosSupport: { type: Boolean, default: false },
    },
    blocked: {
      type: new Schema({ at: Date, by: String, reason: { type: String, default: null } }, { _id: false }),
      default: null,
    },
    fingerprint: { type: String, default: null },
    idConflict: {
      type: new Schema({ at: Date, hostname: { type: String, default: null } }, { _id: false }),
      default: null,
    },
    diagnostics: {
      type: {
        diskFreeBytes: { type: Number, default: null },
        diskTotalBytes: { type: Number, default: null },
        nodeVersion: { type: String, default: null },
        cpuPercent: { type: Number, default: null },
        cpuCount: { type: Number, default: null },
        memTotalBytes: { type: Number, default: null },
        memFreeBytes: { type: Number, default: null },
      },
      default: null,
    },
    lastHeartbeatAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

export const Host = model<IHost>('MachineHost', hostSchema);
