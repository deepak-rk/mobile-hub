import { Host, IHost } from './host.model';
import { Device } from '../devices/device.model';
import { failAbandonedInstallTargets } from '../device-installs/install-runs.service';
import { failAbandonedUninstallTargets } from '../device-installs/uninstall-runs.service';

const OFFLINE_AFTER_MS = 30_000; // mark offline after 30s of no heartbeat
export const HOST_STALE_CHECK_INTERVAL_MS = 10_000; // how often markStaleHostsOffline should be polled

export async function upsertHeartbeat(data: {
  machineId: string;
  hostname: string;
  os: IHost['os'];
  agentVersion: string;
  capabilities: IHost['capabilities'];
  /** Absent for an agent that predates this field — left untouched on that host's existing record rather than overwritten with nulls. */
  diagnostics?: IHost['diagnostics'];
}): Promise<IHost> {
  const { diagnostics, ...rest } = data;
  const host = await Host.findOneAndUpdate(
    { machineId: data.machineId },
    {
      ...rest,
      ...(diagnostics !== undefined ? { diagnostics } : {}),
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
export async function markStaleHostsOffline(): Promise<{
  hosts: number;
  devices: number;
  abandonedInstalls: number;
}> {
  const cutoff = new Date(Date.now() - OFFLINE_AFTER_MS);

  const stale = await Host.find({ lastHeartbeatAt: { $lt: cutoff }, status: 'online' }).select('machineId');
  if (stale.length === 0) return { hosts: 0, devices: 0, abandonedInstalls: 0 };

  const machineIds = stale.map((h) => h.machineId);

  const hostResult = await Host.updateMany({ machineId: { $in: machineIds } }, { status: 'offline' });
  const deviceResult = await Device.updateMany(
    { machineId: { $in: machineIds }, status: { $ne: 'offline' } },
    { status: 'offline', isLocallyReachable: false, lock: null },
  );

  // The agent that was doing this host's installs/uninstalls is gone, so
  // anything it had started is abandoned. It is never retried on its own:
  // the agent only ever picks up `queued` targets, so one left at
  // `transferring` sat in that status forever — no retry, no error, and the
  // device kept reporting an active install while simultaneously being
  // marked offline above. Deliberately scoped to hosts that genuinely
  // stopped heartbeating rather than run at hub startup: these targets are
  // the agent's work, not the hub's, so a hub restart must leave a still-live
  // install alone.
  const [installs, uninstalls] = await Promise.all([
    failAbandonedInstallTargets(machineIds),
    failAbandonedUninstallTargets(machineIds),
  ]);

  return {
    hosts: hostResult.modifiedCount,
    devices: deviceResult.modifiedCount,
    abandonedInstalls: installs + uninstalls,
  };
}
