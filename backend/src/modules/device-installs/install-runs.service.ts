import { getBuild } from '../builds/builds.service';
import { getDevice } from '../devices/devices.service';
import { InstallRun, IInstallRun, InstallTargetStatus } from './install-run.model';
import { publishInstallEvent } from './install-runs.events';

export class BuildNotReadyError extends Error {
  constructor(status: string) {
    super(`Build is '${status}', not 'ready'`);
    this.name = 'BuildNotReadyError';
  }
}

export class UnknownDeviceError extends Error {
  constructor(udid: string) {
    super(`Unknown device: ${udid}`);
    this.name = 'UnknownDeviceError';
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
export class IncompatibleDeviceError extends Error {
  constructor(udid: string, devicePlatform: string, buildPlatform: string) {
    super(`Device ${udid} is ${devicePlatform}; this build is ${buildPlatform}`);
    this.name = 'IncompatibleDeviceError';
  }
}

export interface TriggerInstallRunInput {
  buildId: string;
  deviceUdids: string[];
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
  if (!build) throw new Error(`Build not found: ${input.buildId}`);
  if (build.status !== 'ready') throw new BuildNotReadyError(build.status);

  const targets = await Promise.all(
    input.deviceUdids.map(async (udid) => {
      const device = await getDevice(udid);
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
}

/**
 * What an agent's heartbeat response carries: every target still queued for
 * this machine, across every install run. Not scoped to "started but not
 * finished" — 'downloading'/'installing' targets are excluded so an agent
 * that's still working one (or restarted mid-poll-cycle) doesn't get told to
 * start it a second time; see agent.ts's in-flight tracking for the other
 * half of that guard.
 */
export async function getPendingInstallsForMachine(machineId: string): Promise<PendingInstall[]> {
  const runs = await InstallRun.find({ 'targets.machineId': machineId, 'targets.status': 'queued' });
  const pending: PendingInstall[] = [];
  for (const run of runs) {
    for (const target of run.targets) {
      if (target.machineId === machineId && target.status === 'queued') {
        pending.push({
          installRunId: run.id as string,
          deviceUdid: target.deviceUdid,
          buildId: run.buildId.toString(),
          platform: run.platform,
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
  const runs = await InstallRun.find({ 'targets.status': { $in: ['queued', 'downloading', 'installing'] } });
  const udids = new Set<string>();
  for (const run of runs) {
    for (const target of run.targets) {
      if (target.status === 'queued' || target.status === 'downloading' || target.status === 'installing') {
        udids.add(target.deviceUdid);
      }
    }
  }
  return udids;
}

export interface ReportTargetProgressInput {
  status: InstallTargetStatus;
  progress?: number;
  error?: string;
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
