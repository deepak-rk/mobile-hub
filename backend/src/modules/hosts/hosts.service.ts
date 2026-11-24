import { Host, IHost } from './host.model';
import { Device } from '../devices/device.model';
import { DeviceJob } from '../device-jobs/device-job.model';
import { ForbiddenError, NotFoundError } from '../../common/errors/app-error';
import { failAbandonedInstallTargets, failStrandedQueuedInstallTargets } from '../device-installs/install-runs.service';
import { failAbandonedUninstallTargets, failStrandedQueuedUninstallTargets } from '../device-installs/uninstall-runs.service';

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

/** A blocked host's agent calling in. 403 with a message the agent prints as-is. */
export class HostBlockedError extends ForbiddenError {
  constructor(machineId: string) {
    super(
      `Host '${machineId}' was removed from the lab by an admin. It can rejoin once an admin unblocks it.`,
      'AGENT_BLOCKED',
    );
  }
}

/** Called before any agent traffic is acted on: heartbeat, device sync, job poll. */
export async function assertHostNotBlocked(machineId: string): Promise<void> {
  if (await Host.exists({ machineId, blocked: { $ne: null } })) throw new HostBlockedError(machineId);
}

/**
 * Removes a host from the lab and keeps it removed. Everything it held is let
 * go at once, the same way a host that stops heartbeating is treated, but
 * without waiting for the timeouts: its devices go offline and their locks
 * are released, its in-flight and queued installs fail, its device jobs are
 * interrupted.
 */
export async function blockHost(
  machineId: string,
  by: string,
  reason?: string,
): Promise<{ host: IHost; devices: number; work: number }> {
  const host = await Host.findOneAndUpdate(
    { machineId },
    { blocked: { at: new Date(), by, reason: reason ?? null }, status: 'offline' },
    { new: true },
  );
  if (!host) throw new NotFoundError('Host not found');
  const now = new Date();
  const [devices, installs, uninstalls, queuedInstalls, queuedUninstalls, jobs] = await Promise.all([
    Device.updateMany(
      { machineId, status: { $ne: 'offline' } },
      { status: 'offline', isLocallyReachable: false, lock: null },
    ),
    failAbandonedInstallTargets([machineId]),
    failAbandonedUninstallTargets([machineId]),
    // "Created before" is strict; a second past now covers anything queued up to the block.
    failStrandedQueuedInstallTargets([machineId], new Date(now.getTime() + 1000)),
    failStrandedQueuedUninstallTargets([machineId], new Date(now.getTime() + 1000)),
    DeviceJob.updateMany(
      { machineId, status: { $in: ['queued', 'running'] } },
      { $set: { status: 'interrupted', error: 'The host was removed from the lab.', endedAt: now } },
    ),
  ]);
  return {
    host,
    devices: devices.modifiedCount,
    work: installs + uninstalls + queuedInstalls + queuedUninstalls + jobs.modifiedCount,
  };
}

/** Lets a blocked host back in; it shows up again on its next heartbeat. */
export async function unblockHost(machineId: string): Promise<IHost> {
  const host = await Host.findOneAndUpdate({ machineId }, { blocked: null }, { new: true });
  if (!host) throw new NotFoundError('Host not found');
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

/** How long a host must have been silent before work queued for it is failed rather than left waiting. */
export const STRANDED_WORK_AFTER_MS = 3 * 60_000;

/**
 * Fails queued install/uninstall targets on hosts silent for longer than
 * `STRANDED_WORK_AFTER_MS`. Run on the same tick as `markStaleHostsOffline`
 * (which only acts on the online → offline transition, so it would never
 * reach work queued *after* a host was already down).
 */
export async function failWorkStrandedOnOfflineHosts(): Promise<number> {
  const cutoff = new Date(Date.now() - STRANDED_WORK_AFTER_MS);
  const hosts = await Host.find({ status: 'offline', lastHeartbeatAt: { $lt: cutoff } }).select('machineId');
  if (hosts.length === 0) return 0;
  const machineIds = hosts.map((h) => h.machineId);
  const [installs, uninstalls] = await Promise.all([
    failStrandedQueuedInstallTargets(machineIds, cutoff),
    failStrandedQueuedUninstallTargets(machineIds, cutoff),
  ]);
  return installs + uninstalls;
}

const LOOPBACK = /^(127\.|::1$|::ffff:127\.|localhost$|0\.0\.0\.0$|::$)/i;

/**
 * The host the hub should dial for an agent's Appium.
 *
 * An agent reports the host it believes it is reachable on, and the default
 * (`AGENT_APPIUM_HOST=127.0.0.1`) is only right when hub and agent share a
 * machine. Taken at its word from a remote agent, the hub then dialled its
 * *own* loopback and every remote run failed to create a session. When the
 * report is a loopback/unspecified address but the request itself came from
 * elsewhere, the request's source address is the one that demonstrably
 * reaches the hub from that agent, so it is used instead — the same lesson a
 * production farm in this domain learned ("register with the agent's own
 * reachable IP"). A non-loopback report is always kept: an operator who set
 * it knows their network (NAT, a dedicated interface) better than we do.
 */
export function reachableAgentHost(reportedHost: string, requestIp: string): string {
  if (!LOOPBACK.test(reportedHost)) return reportedHost;
  if (LOOPBACK.test(requestIp)) return reportedHost; // same machine: loopback is correct
  return requestIp.replace(/^::ffff:/, '');
}
