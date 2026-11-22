import { resolveDevice, findReportedTarget, type DeviceRef } from '../devices/devices.service';
import { UninstallRun, IUninstallRun, UninstallTargetStatus } from './uninstall-run.model';
import { ValidationError } from '../../common/errors/app-error';

const IN_FLIGHT_TARGET_STATUSES: UninstallTargetStatus[] = ['queued', 'uninstalling'];

// A 400, matching UnknownDeviceError's own reasoning in install-runs.service.ts:
// the caller supplied a udid that doesn't resolve to any known device, which
// is a malformed request, not a missing resource.
export class UnknownDeviceError extends ValidationError {
  constructor(udid: string) {
    super(`Unknown device: ${udid}`, 'UNKNOWN_DEVICE');
  }
}

export interface TriggerUninstallRunInput {
  packageName: string;
  project: string;
  devices: DeviceRef[];
  triggeredBy: string;
}

/**
 * Creates the UninstallRun and returns immediately — same agent-polls, hub
 * relays-only shape as triggerInstallRun, for the same reason: there is no
 * orchestration to kick off centrally, only state for the agent to discover
 * on its next heartbeat and act on itself.
 *
 * Deliberately does not check `getInstalledDevicesForBuild` or any other
 * "is this package really there" gate beyond device existence — the agent's
 * own `pm uninstall` is the actual source of truth for what's on a device,
 * and a hub-side check would just be a second, staler copy of that answer
 * (the whole reason `getInstalledDevicesForBuild` says "currently" rather
 * than "ever" is that this exact kind of drift is expected). Callers that
 * want a compatibility check up front (the frontend's own trigger UI) do it
 * themselves against `getInstalledDevicesForBuild` before calling this.
 */
export async function triggerUninstallRun(input: TriggerUninstallRunInput): Promise<IUninstallRun> {
  const targets = await Promise.all(
    input.devices.map(async ({ udid, machineId }) => {
      const device = await resolveDevice(udid, machineId);
      if (!device) throw new UnknownDeviceError(udid);
      return {
        deviceUdid: udid,
        machineId: device.machineId,
        status: 'queued' as const,
        error: null,
        startedAt: null,
        endedAt: null,
      };
    }),
  );

  return UninstallRun.create({
    packageName: input.packageName,
    project: input.project,
    targets,
    triggeredBy: input.triggeredBy,
  });
}

export async function listUninstallRuns(filters: {
  project?: string;
  deviceUdid?: string;
}): Promise<IUninstallRun[]> {
  const query: Record<string, unknown> = {};
  if (filters.project) query.project = filters.project;
  if (filters.deviceUdid) query['targets.deviceUdid'] = filters.deviceUdid;
  return UninstallRun.find(query).sort({ createdAt: -1 });
}

export async function getUninstallRun(id: string): Promise<IUninstallRun | null> {
  return UninstallRun.findById(id);
}

export interface PendingUninstall {
  uninstallRunId: string;
  deviceUdid: string;
  packageName: string;
}

/**
 * What an agent's heartbeat response carries for uninstalls — mirrors
 * getPendingInstallsForMachine exactly, including excluding 'uninstalling'
 * targets so a restarted agent doesn't get told to start one a second time
 * (see agent.ts's in-flight tracking for the other half of that guard).
 */
export async function getPendingUninstallsForMachine(machineId: string): Promise<PendingUninstall[]> {
  const runs = await UninstallRun.find({ 'targets.machineId': machineId, 'targets.status': 'queued' });
  const pending: PendingUninstall[] = [];
  for (const run of runs) {
    for (const target of run.targets) {
      if (target.machineId === machineId && target.status === 'queued') {
        pending.push({ uninstallRunId: run.id as string, deviceUdid: target.deviceUdid, packageName: run.packageName });
      }
    }
  }
  return pending;
}

/**
 * The uninstall counterpart to `failAbandonedInstallTargets` — see that
 * function for the full reasoning. `queued` is excluded for the same reason:
 * the returning agent picks those up normally.
 */
export async function failAbandonedUninstallTargets(machineIds: string[]): Promise<number> {
  if (machineIds.length === 0) return 0;
  const match = { machineId: { $in: machineIds }, status: 'uninstalling' };
  const result = await UninstallRun.updateMany(
    { targets: { $elemMatch: match } },
    {
      $set: {
        'targets.$[t].status': 'error',
        'targets.$[t].error': 'Host agent stopped responding mid-uninstall',
        'targets.$[t].endedAt': new Date(),
      },
    },
    { arrayFilters: [{ 't.machineId': match.machineId, 't.status': match.status }] },
  );
  return result.modifiedCount;
}

/** Same shape as install-runs.service.ts's own getActiveInstallCountForMachine, for host diagnostics. */
export async function getActiveUninstallCountForMachine(machineId: string): Promise<number> {
  return UninstallRun.countDocuments({
    'targets.machineId': machineId,
    'targets.status': { $in: IN_FLIGHT_TARGET_STATUSES },
  });
}

export interface ReportUninstallTargetProgressInput {
  status: UninstallTargetStatus;
  error?: string;
}

export async function reportUninstallTargetProgress(
  uninstallRunId: string,
  deviceUdid: string,
  update: ReportUninstallTargetProgressInput,
  machineId?: string,
): Promise<IUninstallRun | null> {
  const run = await UninstallRun.findById(uninstallRunId);
  if (!run) return null;

  const target = findReportedTarget(run.targets, deviceUdid, machineId);
  if (!target) return null;

  if (target.status === 'queued' && update.status !== 'queued') target.startedAt = new Date();
  if (update.status === 'done' || update.status === 'error') target.endedAt = new Date();
  target.status = update.status;
  if (update.error !== undefined) target.error = update.error;

  await run.save();
  return run;
}

/** The uninstall counterpart to `failStrandedQueuedInstallTargets` — same rule, same reason. */
export async function failStrandedQueuedUninstallTargets(machineIds: string[], createdBefore: Date): Promise<number> {
  if (machineIds.length === 0) return 0;
  const match = { machineId: { $in: machineIds }, status: 'queued' };
  const result = await UninstallRun.updateMany(
    { createdAt: { $lt: createdBefore }, targets: { $elemMatch: match } },
    {
      $set: {
        'targets.$[t].status': 'error',
        'targets.$[t].error': 'Host agent offline — the uninstall was never picked up',
        'targets.$[t].endedAt': new Date(),
      },
    },
    { arrayFilters: [{ 't.machineId': match.machineId, 't.status': 'queued' }] },
  );
  return result.modifiedCount;
}
