import { getBuild } from '../builds/builds.service';
import { Build } from '../builds/build.model';
import { getDevicesByUdids, resolveDevice, type DeviceRef } from '../devices/devices.service';
import { InstallRun, IInstallRun, InstallTargetStatus } from './install-run.model';
import { UninstallRun } from './uninstall-run.model';
import { publishInstallEvent } from './install-runs.events';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors/app-error';

/**
 * Statuses meaning "this device is busy with an install right now".
 *
 * Declared once and used by both the Mongo query and the in-memory filter
 * below: those were two hand-maintained copies of the same list, which is
 * exactly how adding the `transferring` phase would have silently made a
 * mid-transfer device read as idle again — the lie `activeInstall` exists to
 * prevent.
 */
const IN_FLIGHT_TARGET_STATUSES: InstallTargetStatus[] = [
  'queued',
  'downloading',
  'transferring',
  'installing',
  'granting-permissions',
];

export class BuildNotReadyError extends ConflictError {
  constructor(status: string) {
    super(`Build is '${status}', not 'ready'`, 'BUILD_NOT_READY');
  }
}

// A 400 ValidationError, not a 404 — install-runs.routes.ts was already
// mapping this to 400 (the caller supplied a udid that doesn't resolve to
// any known device, which is a malformed request, not a missing resource).
export class UnknownDeviceError extends ValidationError {
  constructor(udid: string) {
    super(`Unknown device: ${udid}`, 'UNKNOWN_DEVICE');
  }
}

/**
 * A target whose platform the artifact cannot run on.
 *
 * Rejected at trigger time rather than left to fail at the agent: an Android
 * APK sent to an iOS device previously produced a late, confusing error from
 * `adb` (or the iOS "not implemented" branch) with nothing explaining that the
 * request was impossible from the start. The frontend already filters the
 * device picker by platform — this is the server-side half, because a filtered
 * picker is a convenience and never a guarantee.
 */
export class IncompatibleDeviceError extends ValidationError {
  constructor(udid: string, devicePlatform: string, buildPlatform: string) {
    super(`Device ${udid} is ${devicePlatform}; this build is ${buildPlatform}`, 'INCOMPATIBLE_DEVICE');
  }
}

export interface TriggerInstallRunInput {
  buildId: string;
  devices: DeviceRef[];
  triggeredBy: string;
}

/**
 * Creates the InstallRun and returns immediately — unlike execution's
 * triggerExecutionRun, there is no background orchestration to kick off
 * here. The agent discovers queued targets for its own machineId on its
 * next heartbeat poll (see hosts.routes.ts's heartbeat response) and drives
 * the download/install itself; the hub only stores state and relays
 * progress. Deliberately does NOT call acquireLock — see install-run.model.ts's
 * doc comment for why.
 */
export async function triggerInstallRun(input: TriggerInstallRunInput): Promise<IInstallRun> {
  const build = await getBuild(input.buildId);
  if (!build) throw new NotFoundError(`Build not found: ${input.buildId}`, 'BUILD_NOT_FOUND');
  if (build.status !== 'ready') throw new BuildNotReadyError(build.status);

  const targets = await Promise.all(
    input.devices.map(async ({ udid, machineId }) => {
      const device = await resolveDevice(udid, machineId);
      if (!device) throw new UnknownDeviceError(udid);
      if (device.platform !== build.platform) {
        throw new IncompatibleDeviceError(udid, device.platform, build.platform);
      }
      return {
        deviceUdid: udid,
        machineId: device.machineId,
        status: 'queued' as const,
        progress: 0,
        error: null,
        startedAt: null,
        endedAt: null,
        packageName: null,
      };
    }),
  );

  return InstallRun.create({
    buildId: build._id,
    project: build.project,
    platform: build.platform,
    targets,
    triggeredBy: input.triggeredBy,
  });
}

export async function listInstallRuns(filters: { project?: string; deviceUdid?: string }): Promise<IInstallRun[]> {
  const query: Record<string, unknown> = {};
  if (filters.project) query.project = filters.project;
  if (filters.deviceUdid) query['targets.deviceUdid'] = filters.deviceUdid;
  return InstallRun.find(query).sort({ createdAt: -1 });
}

export async function getInstallRun(id: string): Promise<IInstallRun | null> {
  return InstallRun.findById(id);
}

export interface PendingInstall {
  installRunId: string;
  deviceUdid: string;
  buildId: string;
  platform: 'android' | 'ios';
  /**
   * The artifact's size, straight from the `Build` record.
   *
   * The agent could read `Content-Length` off the artifact response instead,
   * but that header is not guaranteed (a proxy using chunked encoding drops
   * it), and a missing total means no honest percentage. The hub already
   * knows the size authoritatively — sending it removes the dependency on a
   * header entirely rather than degrading when it is absent.
   */
  sizeBytes: number | null;
  /**
   * The build's original source, straight off `Build.artifactUrl` — whatever
   * the `BuildProvider` that fetched it reported as `sourceUrl`. Passed
   * through as-is, including a `file://` URL the agent has no way to read (a
   * path on the *hub's* disk) — the agent decides what's actually attemptable
   * from its own network, the hub doesn't filter. Lets the agent skip the hub
   * as a byte proxy and fetch directly from the origin when that's reachable,
   * falling back to the hub otherwise; see `hub-client.ts`'s
   * `downloadArtifactDirect`.
   */
  artifactUrl: string | null;
  /**
   * Org-wide `devices.grantPermissionsOnInstall` toggle, carried per target
   * since the agent has no access to org config itself. Android only.
   */
  grantPermissions: boolean;
}

/**
 * What an agent's heartbeat response carries: every target still queued for
 * this machine, across every install run. Not scoped to "started but not
 * finished" — 'downloading'/'installing' targets are excluded so an agent
 * that's still working one (or restarted mid-poll-cycle) doesn't get told to
 * start it a second time; see agent.ts's in-flight tracking for the other
 * half of that guard.
 */
export async function getPendingInstallsForMachine(
  machineId: string,
  // Org-wide toggle (EffectiveConfig.devices.grantPermissionsOnInstall),
  // threaded through per target rather than looked up by the agent itself —
  // the agent has no access to org config, only whatever the hub tells it.
  // Defaults false so every existing caller (and every test predating this
  // parameter) keeps today's exact behaviour without passing it.
  grantPermissionsOnInstall = false,
): Promise<PendingInstall[]> {
  const runs = await InstallRun.find({ 'targets.machineId': machineId, 'targets.status': 'queued' });
  if (runs.length === 0) return [];

  // One query for every distinct build across all pending runs, rather than a
  // lookup per target — this runs on every agent heartbeat, so it must not
  // scale with the number of devices being installed to.
  const buildIds = [...new Set(runs.map((r) => r.buildId.toString()))];
  const builds = await Build.find({ _id: { $in: buildIds } }).select('sizeBytes artifactUrl');
  const sizeByBuildId = new Map(builds.map((b) => [b.id as string, b.sizeBytes]));
  const artifactUrlByBuildId = new Map(builds.map((b) => [b.id as string, b.artifactUrl || null]));

  const pending: PendingInstall[] = [];
  for (const run of runs) {
    const buildId = run.buildId.toString();
    for (const target of run.targets) {
      if (target.machineId === machineId && target.status === 'queued') {
        pending.push({
          installRunId: run.id as string,
          deviceUdid: target.deviceUdid,
          buildId,
          platform: run.platform,
          sizeBytes: sizeByBuildId.get(buildId) ?? null,
          artifactUrl: artifactUrlByBuildId.get(buildId) ?? null,
          grantPermissions: grantPermissionsOnInstall,
        });
      }
    }
  }
  return pending;
}

/**
 * UDIDs with an install currently in flight.
 *
 * Exists because installs deliberately do not take the device lock (see
 * install-run.model.ts). That decision is fine, but it left the device list
 * telling a visible lie: a device being actively reinstalled still read as
 * `idle`, i.e. free to grab. Surfacing the activity separately keeps the
 * no-locking decision while removing the lie — the alternative, folding this
 * into `status`, would mean an enum entry per combination of concurrent
 * activities.
 */
export async function getActiveInstallUdids(): Promise<Set<string>> {
  const runs = await InstallRun.find({ 'targets.status': { $in: IN_FLIGHT_TARGET_STATUSES } });
  const udids = new Set<string>();
  for (const run of runs) {
    for (const target of run.targets) {
      if (IN_FLIGHT_TARGET_STATUSES.includes(target.status)) udids.add(target.deviceUdid);
    }
  }
  return udids;
}

/**
 * The started-but-not-finished statuses — everything in-flight except
 * `queued`.
 *
 * `queued` is deliberately excluded: that target has not been picked up by
 * any agent yet, so when the host comes back its agent will discover and run
 * it normally (`getPendingInstallsForMachine` queries exactly `queued`).
 * Failing it would turn a recoverable wait into a permanent error.
 */
const ABANDONED_ON_HOST_LOSS: InstallTargetStatus[] = IN_FLIGHT_TARGET_STATUSES.filter((s) => s !== 'queued');

/**
 * Fails install targets that an agent started and then disappeared mid-way.
 *
 * Only ever called for hosts that have genuinely stopped heartbeating (see
 * `markStaleHostsOffline`) — **not** at hub startup, which would be wrong:
 * these targets belong to the agent, not the hub, so a hub restart leaves
 * them legitimately still running and failing them would both lie and
 * invite a duplicate install.
 *
 * Without this they were stuck forever (found 2026-09-22): the agent only
 * ever picks up `queued` targets, so one it abandoned at `transferring` was
 * never retried and never failed — the install silently never finished, with
 * no error anywhere, and `getActiveInstallUdids` kept reporting the device as
 * installing, so it showed an "Installing" badge indefinitely while also
 * being marked offline.
 */
export async function failAbandonedInstallTargets(machineIds: string[]): Promise<number> {
  if (machineIds.length === 0) return 0;
  const match = { machineId: { $in: machineIds }, status: { $in: ABANDONED_ON_HOST_LOSS } };
  const result = await InstallRun.updateMany(
    { targets: { $elemMatch: match } },
    {
      $set: {
        'targets.$[t].status': 'error',
        'targets.$[t].error': 'Host agent stopped responding mid-install',
        'targets.$[t].endedAt': new Date(),
      },
    },
    { arrayFilters: [{ 't.machineId': match.machineId, 't.status': match.status }] },
  );
  return result.modifiedCount;
}

/**
 * Install runs with at least one in-flight target on this machine, for host
 * diagnostics. Counts runs, not individual targets — good enough for "is
 * this host doing install work right now", not meant as a precise target tally.
 */
export async function getActiveInstallCountForMachine(machineId: string): Promise<number> {
  return InstallRun.countDocuments({
    'targets.machineId': machineId,
    'targets.status': { $in: IN_FLIGHT_TARGET_STATUSES },
  });
}

export interface InstalledDevice {
  deviceUdid: string;
  /** Null when the device has since been deregistered/never synced — the
   * install history is still real even if the device it named isn't around
   * to look up any more. */
  deviceName: string | null;
  installRunId: string;
  installedAt: Date | null;
  /** Null for a run that predates IInstallTarget.packageName, or a
   * same-version reinstall the agent couldn't positively attribute. Uninstall
   * needs this — a device entry with a null packageName has nothing to
   * offer it. */
  packageName: string | null;
}

/**
 * Devices that currently have this build installed.
 *
 * "Currently" is the load-bearing word, and it's why this isn't just a filter
 * for successful targets of this build: a device holds one copy of an app at a
 * time, so installing a *different* build of the same project replaces this
 * one. A device is therefore reported only when this build is the most recent
 * successful install it received for the build's project+platform — otherwise
 * the UI would keep claiming a device "has" a build that was overwritten days
 * ago. The same logic applies to a completed uninstall: a device whose most
 * recent event for this package was a successful uninstall no longer has it,
 * regardless of what install history precedes that uninstall.
 *
 * Scoped to project+platform rather than every run because installs of an
 * unrelated project don't touch this app's package.
 */
export async function getInstalledDevicesForBuild(buildId: string): Promise<InstalledDevice[]> {
  const build = await getBuild(buildId);
  if (!build) return [];

  // Oldest first, so the last write per device wins and the map ends up
  // holding each device's most recent successful install.
  const runs = await InstallRun.find({
    project: build.project,
    platform: build.platform,
    'targets.status': 'done',
  }).sort({ createdAt: 1 });

  const latestByDevice = new Map<
    string,
    { buildId: string; installRunId: string; installedAt: Date | null; packageName: string | null }
  >();
  for (const run of runs) {
    for (const target of run.targets) {
      if (target.status !== 'done') continue;
      latestByDevice.set(target.deviceUdid, {
        buildId: run.buildId.toString(),
        installRunId: run.id as string,
        installedAt: target.endedAt,
        packageName: target.packageName,
      });
    }
  }

  const current = [...latestByDevice.entries()].filter(([, latest]) => latest.buildId === buildId);

  // A device whose package was successfully uninstalled *after* this install
  // completed no longer has it — checked per (device, package), not just
  // per device, so an uninstall of an unrelated package on the same device
  // can't hide this one. A device with a null packageName has nothing to
  // check against and is left as-is, same as before this existed.
  const packageNames = [...new Set(current.map(([, latest]) => latest.packageName).filter((p): p is string => Boolean(p)))];
  const uninstallRuns =
    packageNames.length > 0
      ? await UninstallRun.find({
          packageName: { $in: packageNames },
          'targets.deviceUdid': { $in: current.map(([udid]) => udid) },
          'targets.status': 'done',
        })
      : [];
  const uninstalledAt = new Map<string, Date>(); // `${udid}:${packageName}` -> latest completed uninstall time
  for (const run of uninstallRuns) {
    for (const target of run.targets) {
      if (target.status !== 'done' || !target.endedAt) continue;
      const key = `${target.deviceUdid}:${run.packageName}`;
      const existing = uninstalledAt.get(key);
      if (!existing || target.endedAt > existing) uninstalledAt.set(key, target.endedAt);
    }
  }
  const stillInstalled = current.filter(([udid, latest]) => {
    if (!latest.packageName) return true;
    const removedAt = uninstalledAt.get(`${udid}:${latest.packageName}`);
    if (!removedAt) return true;
    return latest.installedAt !== null && removedAt <= latest.installedAt;
  });

  // One batch lookup for names rather than N+1 single-device queries.
  const devices = await getDevicesByUdids(stillInstalled.map(([udid]) => udid));
  const nameByUdid = new Map(devices.map((d) => [d.udid, d.name]));

  return stillInstalled.map(([deviceUdid, latest]) => ({
    deviceUdid,
    deviceName: nameByUdid.get(deviceUdid) ?? null,
    installRunId: latest.installRunId,
    installedAt: latest.installedAt,
    packageName: latest.packageName,
  }));
}

export interface ReportTargetProgressInput {
  status: InstallTargetStatus;
  progress?: number;
  error?: string;
  /** Set once, alongside `status: 'done'` — see IInstallTarget.packageName. */
  packageName?: string;
}

export async function reportTargetProgress(
  installRunId: string,
  deviceUdid: string,
  update: ReportTargetProgressInput,
): Promise<IInstallRun | null> {
  const run = await InstallRun.findById(installRunId);
  if (!run) return null;

  const target = run.targets.find((t) => t.deviceUdid === deviceUdid);
  if (!target) return null;

  if (target.status === 'queued' && update.status !== 'queued') target.startedAt = new Date();
  if (update.status === 'done' || update.status === 'error') target.endedAt = new Date();
  target.status = update.status;
  if (update.progress !== undefined) target.progress = update.progress;
  if (update.error !== undefined) target.error = update.error;
  if (update.packageName !== undefined) target.packageName = update.packageName;

  await run.save();
  publishInstallEvent(installRunId, {
    type: 'target',
    deviceUdid,
    status: target.status,
    progress: target.progress,
    error: target.error ?? undefined,
  });
  return run;
}

/**
 * Fails `queued` install targets stranded on hosts that have stayed offline.
 *
 * `failAbandonedInstallTargets` deliberately leaves `queued` alone when a host
 * first goes stale, because the returning agent resumes those. But a host
 * that stays down turns that into a silent dead end: the install sits
 * "queued" indefinitely and whoever is waiting on it never learns why. A
 * production farm in this domain fails these after 3 minutes ("agent with no
 * heartbeat in 3 min, or job still queued after 3 min → fail now"); the
 * caller applies the same rule by passing hosts offline that long and a
 * matching `createdBefore`, so a target queued *just* before a blip is not
 * failed by it.
 */
export async function failStrandedQueuedInstallTargets(machineIds: string[], createdBefore: Date): Promise<number> {
  if (machineIds.length === 0) return 0;
  const match = { machineId: { $in: machineIds }, status: 'queued' };
  const result = await InstallRun.updateMany(
    { createdAt: { $lt: createdBefore }, targets: { $elemMatch: match } },
    {
      $set: {
        'targets.$[t].status': 'error',
        'targets.$[t].error': 'Host agent offline — the install was never picked up',
        'targets.$[t].endedAt': new Date(),
      },
    },
    { arrayFilters: [{ 't.machineId': match.machineId, 't.status': 'queued' }] },
  );
  return result.modifiedCount;
}
