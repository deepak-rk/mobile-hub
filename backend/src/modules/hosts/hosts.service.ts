import { Host, IHost } from './host.model';

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

export async function markStaleHostsOffline(): Promise<number> {
  const cutoff = new Date(Date.now() - OFFLINE_AFTER_MS);
  const result = await Host.updateMany(
    { lastHeartbeatAt: { $lt: cutoff }, status: 'online' },
    { status: 'offline' },
  );
  return result.modifiedCount;
}
