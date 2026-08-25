import { Host, IHost } from './host.model';
import { Device } from '../devices/device.model';

const OFFLINE_AFTER_MS = 30_000; // mark offline after 30s of no heartbeat
export const HOST_STALE_CHECK_INTERVAL_MS = 10_000; // how often markStaleHostsOffline should be polled

export async function upsertHeartbeat(data: {
  machineId: string;
  hostname: string;
  os: IHost['os'];
  agentVersion: string;
  capabilities: IHost['capabilities'];
}): Promise<IHost> {
  const host = await Host.findOneAndUpdate(
    { machineId: data.machineId },
    {
      ...data,
      status: 'online',
      lastHeartbeatAt: new Date(),
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  return host;
}

export async function listHosts(): Promise<IHost[]> {
  return Host.find().sort({ hostname: 1 });
}

export async function getHost(machineId: string): Promise<IHost | null> {
  return Host.findOne({ machineId });
}

/**
 * Marks hosts that stopped heartbeating as offline, **and takes their devices
 * down with them.**
 *
 * A device is only reachable through its host's agent, so when the agent dies
 * every device on that machine is unreachable too — but nothing re-syncs them,
 * so they would otherwise sit at `idle` and read as available. Someone could
 * then lock one, or trigger a run against a machine that isn't there, and get
 * a confusing failure or a lock held on a phantom device.
 *
 * Locks are released for the same reason `syncDevices` releases them when a
 * host stops reporting a device: a lock on something unreachable can never be
 * released by its holder.
 */
export async function markStaleHostsOffline(): Promise<{ hosts: number; devices: number }> {
  const cutoff = new Date(Date.now() - OFFLINE_AFTER_MS);

  const stale = await Host.find({ lastHeartbeatAt: { $lt: cutoff }, status: 'online' }).select('machineId');
  if (stale.length === 0) return { hosts: 0, devices: 0 };

  const machineIds = stale.map((h) => h.machineId);

  const hostResult = await Host.updateMany({ machineId: { $in: machineIds } }, { status: 'offline' });
  const deviceResult = await Device.updateMany(
    { machineId: { $in: machineIds }, status: { $ne: 'offline' } },
    { status: 'offline', isLocallyReachable: false, lock: null },
  );

  return { hosts: hostResult.modifiedCount, devices: deviceResult.modifiedCount };
}
