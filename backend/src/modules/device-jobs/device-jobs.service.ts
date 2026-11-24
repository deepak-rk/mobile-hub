import { EventEmitter } from 'events';
import { ConflictError, ForbiddenError, NotFoundError } from '../../common/errors/app-error';
import { describeAction, type DeviceAction } from '../../common/device-actions';
import { resolveDevice } from '../devices/devices.service';
import { deviceKey, getActiveInstallDeviceKeys } from '../device-installs/install-runs.service';
import { Host } from '../hosts/host.model';
import { DeviceJob, FINAL_JOB_STATUSES, IDeviceJob } from './device-job.model';

/** A queued job nobody claimed in this long is not run at all: a tap from a minute ago is no longer wanted. */
export const CLAIM_TIMEOUT_MS = 60_000;
/** A claimed job the agent has not reported back on in this long is timed out (its late result is still kept). */
export const RUN_TIMEOUT_MS = 60_000;
const MAX_TEXT = 2000;

// Wakes an agent waiting in `waitForJob` the moment a job for its host is
// queued. In-process only: with several hub instances a waiting agent on
// another instance finds the job on its next poll instead.
const jobEvents = new EventEmitter();
jobEvents.setMaxListeners(0);

export interface CreateDeviceJobInput {
  deviceUdid: string;
  machineId?: string;
  action: DeviceAction;
  userId: string;
  idempotencyKey?: string;
  dryRun?: boolean;
}

export interface DryRunResult {
  dryRun: true;
  machineId: string;
  deviceUdid: string;
  wouldRun: string;
}

/**
 * Queues an action for a phone, or with `dryRun` runs every check and stops
 * short of queueing. The person must hold the phone (its lock), and nothing
 * else may be using it: a test run holds the same lock, and an install, which
 * takes no lock, is checked separately. One phone, one owner at a time.
 */
/** `reused`: an earlier request with the same Idempotency-Key already made this job. */
export interface CreatedJob {
  job: IDeviceJob;
  reused: boolean;
}

export async function createDeviceJob(input: CreateDeviceJobInput): Promise<CreatedJob | DryRunResult> {
  if (input.idempotencyKey && !input.dryRun) {
    const existing = await DeviceJob.findOne({ requestedBy: input.userId, idempotencyKey: input.idempotencyKey });
    if (existing) return { job: existing, reused: true };
  }

  const device = await resolveDevice(input.deviceUdid, input.machineId);
  if (!device) throw new NotFoundError('Device not found');
  if (device.platform !== 'android') {
    throw new ConflictError('Remote control supports Android phones only, for now.', 'UNSUPPORTED_PLATFORM');
  }
  if (device.status === 'offline' || device.status === 'unreachable') {
    throw new ConflictError('The device is not connected.', 'DEVICE_OFFLINE');
  }
  if (device.lock?.reason?.startsWith('execution:')) {
    throw new ConflictError('A test run is using this device.', 'DEVICE_BUSY');
  }
  if (!device.lock || device.lock.heldBy !== input.userId) {
    throw new ConflictError('Take the device (lock it) before controlling it.', 'DEVICE_NOT_HELD');
  }
  if ((await getActiveInstallDeviceKeys()).has(deviceKey(device.machineId, device.udid))) {
    throw new ConflictError('An install is in progress on this device.', 'DEVICE_BUSY');
  }

  if (input.dryRun) {
    return { dryRun: true, machineId: device.machineId, deviceUdid: device.udid, wouldRun: describeAction(input.action) };
  }

  let job: IDeviceJob;
  try {
    job = await DeviceJob.create({
      machineId: device.machineId,
      deviceUdid: device.udid,
      action: input.action,
      requestedBy: input.userId,
      idempotencyKey: input.idempotencyKey ?? null,
    });
  } catch (err) {
    // Two requests with the same key at once: the second gets the first's job.
    if ((err as { code?: number }).code === 11000 && input.idempotencyKey) {
      const existing = await DeviceJob.findOne({ requestedBy: input.userId, idempotencyKey: input.idempotencyKey });
      if (existing) return { job: existing, reused: true };
    }
    throw err;
  }
  jobEvents.emit(job.machineId);
  return { job, reused: false };
}

/** The oldest queued job for a host, claimed atomically, or null. Never one past its claim timeout. */
export async function claimNextJob(machineId: string, now = new Date()): Promise<IDeviceJob | null> {
  return DeviceJob.findOneAndUpdate(
    { machineId, status: 'queued', createdAt: { $gt: new Date(now.getTime() - CLAIM_TIMEOUT_MS) } },
    { $set: { status: 'running', startedAt: now } },
    { sort: { createdAt: 1 }, new: true },
  );
}

/** Long-poll for the agent: a job as soon as one is queued for its host, or null after `waitMs`. */
export async function waitForJob(machineId: string, waitMs: number): Promise<IDeviceJob | null> {
  const ready = await claimNextJob(machineId);
  if (ready || waitMs <= 0) return ready;
  await new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      jobEvents.off(machineId, done);
      resolve();
    };
    const timer = setTimeout(done, waitMs);
    jobEvents.once(machineId, done);
  });
  return claimNextJob(machineId);
}

export interface DeviceJobReport {
  status: 'succeeded' | 'failed';
  output?: string;
  error?: string;
}

/**
 * The agent's result. Accepted for a running job, and also for one already
 * timed out or interrupted (marked `late`): the action did happen, and the
 * record should say so. A repeat of the same final report is a no-op.
 */
export async function reportDeviceJob(id: string, machineId: string | null, report: DeviceJobReport): Promise<IDeviceJob> {
  const job = await DeviceJob.findById(id);
  if (!job) throw new NotFoundError('Device job not found');
  if (machineId && job.machineId !== machineId) {
    throw new ForbiddenError('This job belongs to another host.', 'AGENT_MACHINE_MISMATCH');
  }
  if (FINAL_JOB_STATUSES.includes(job.status)) {
    if (job.status === report.status) return job;
    throw new ConflictError(`This job was already reported ${job.status}.`, 'ALREADY_REPORTED');
  }
  if (job.status === 'queued') throw new ConflictError('This job was never claimed.', 'NOT_CLAIMED');

  const updated = await DeviceJob.findOneAndUpdate(
    { _id: job._id, status: job.status },
    {
      $set: {
        status: report.status,
        output: report.output?.slice(0, MAX_TEXT) ?? null,
        error: report.error?.slice(0, MAX_TEXT) ?? null,
        late: job.status !== 'running',
        endedAt: new Date(),
        // Typed text may be a password: kept only until the agent has used it.
        ...(job.action.kind === 'text' ? { 'action.text': '' } : {}),
      },
    },
    { new: true },
  );
  if (!updated) throw new ConflictError('The job changed while reporting; report again.', 'JOB_CHANGED');
  return updated;
}

/** Timeouts and interruptions; run on the hub's 10 s sweep. */
export async function expireDeviceJobs(now = new Date()): Promise<{ timedOut: number; interrupted: number }> {
  const offline = (await Host.find({ status: 'offline' }).select('machineId')).map((h) => h.machineId);
  const interrupted =
    offline.length === 0
      ? 0
      : (
          await DeviceJob.updateMany(
            { status: { $in: ['queued', 'running'] }, machineId: { $in: offline } },
            { $set: { status: 'interrupted', error: 'The host went offline.', endedAt: now } },
          )
        ).modifiedCount;
  const unclaimed = await DeviceJob.updateMany(
    { status: 'queued', createdAt: { $lte: new Date(now.getTime() - CLAIM_TIMEOUT_MS) } },
    {
      $set: {
        status: 'timed_out',
        error: `No agent picked this up within ${CLAIM_TIMEOUT_MS / 1000} s. Is the agent on this host running?`,
        endedAt: now,
      },
    },
  );
  const unreported = await DeviceJob.updateMany(
    { status: 'running', startedAt: { $lte: new Date(now.getTime() - RUN_TIMEOUT_MS) } },
    {
      $set: {
        status: 'timed_out',
        error: `The agent did not report back within ${RUN_TIMEOUT_MS / 1000} s.`,
        endedAt: now,
      },
    },
  );
  return { timedOut: unclaimed.modifiedCount + unreported.modifiedCount, interrupted };
}

export async function getDeviceJob(id: string): Promise<IDeviceJob> {
  const job = await DeviceJob.findById(id);
  if (!job) throw new NotFoundError('Device job not found');
  return job;
}

export async function listDeviceJobs(deviceUdid: string, machineId?: string, limit = 20): Promise<IDeviceJob[]> {
  return DeviceJob.find(machineId ? { deviceUdid, machineId } : { deviceUdid })
    .sort({ createdAt: -1 })
    .limit(limit);
}
