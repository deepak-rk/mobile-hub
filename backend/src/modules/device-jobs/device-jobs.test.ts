import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { testMongoUri } from '../../common/test-mongo';
import mongoose from 'mongoose';
import { Device } from '../devices/device.model';
import { Host } from '../hosts/host.model';
import { DeviceJob } from './device-job.model';
import {
  CLAIM_TIMEOUT_MS,
  RUN_TIMEOUT_MS,
  claimNextJob,
  createDeviceJob,
  expireDeviceJobs,
  reportDeviceJob,
  waitForJob,
} from './device-jobs.service';

/**
 * Against a real MongoDB (MONGO_TEST_URI, a throwaway database dropped
 * afterwards): the claim, the timeouts and late results depend on real
 * update semantics. CI runs these in its MongoDB job.
 */
const uri = testMongoUri('device_jobs');

describe.runIf(Boolean(uri))('device jobs (MongoDB)', () => {
  beforeAll(async () => {
    await mongoose.connect(uri as string);
    await DeviceJob.syncIndexes();
  });
  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  beforeEach(async () => {
    await Promise.all([DeviceJob.deleteMany({}), Device.deleteMany({}), Host.deleteMany({})]);
  });

  async function phone(over: Record<string, unknown> = {}) {
    return Device.create({
      udid: 'emulator-5554',
      machineId: 'host-a',
      platform: 'android',
      name: 'Pixel',
      osVersion: '14',
      model: 'sdk',
      connectionType: 'emulator',
      status: 'in-use',
      lock: { heldBy: 'u1', sessionId: 's', acquiredAt: new Date() },
      ...over,
    });
  }
  const home = { kind: 'key', key: 'home' } as const;
  // Past the claim timeout. Through the raw driver: Mongoose silently drops
  // a write to the immutable `createdAt`.
  const backdate = (id: unknown) =>
    DeviceJob.collection.updateOne({ _id: id as mongoose.Types.ObjectId }, { $set: { createdAt: new Date(Date.now() - CLAIM_TIMEOUT_MS - 1000) } });
  const create = (over: Record<string, unknown> = {}) =>
    createDeviceJob({ deviceUdid: 'emulator-5554', machineId: 'host-a', action: home, userId: 'u1', ...over });

  it('refuses unless the requester holds the phone and nothing else is using it', async () => {
    await phone({ lock: null, status: 'idle' });
    await expect(create()).rejects.toMatchObject({ code: 'DEVICE_NOT_HELD' });
    await Device.updateOne({}, { lock: { heldBy: 'u2', sessionId: 's', acquiredAt: new Date() } });
    await expect(create()).rejects.toMatchObject({ code: 'DEVICE_NOT_HELD' });
    await Device.updateOne({}, { lock: { heldBy: 'u1', sessionId: 'r', acquiredAt: new Date(), reason: 'execution:r' } });
    await expect(create()).rejects.toMatchObject({ code: 'DEVICE_BUSY' });
    await Device.updateOne({}, { platform: 'ios', lock: { heldBy: 'u1', sessionId: 's', acquiredAt: new Date() } });
    await expect(create()).rejects.toMatchObject({ code: 'UNSUPPORTED_PLATFORM' });
    await Device.updateOne({}, { platform: 'android', status: 'offline' });
    await expect(create()).rejects.toMatchObject({ code: 'DEVICE_OFFLINE' });
    expect(await DeviceJob.countDocuments()).toBe(0);
  });

  it('a dry run checks everything and queues nothing', async () => {
    await phone();
    await expect(create({ dryRun: true })).resolves.toMatchObject({ dryRun: true, wouldRun: 'press home' });
    expect(await DeviceJob.countDocuments()).toBe(0);
  });

  it('the same Idempotency-Key gets the same job', async () => {
    await phone();
    const a = await create({ idempotencyKey: 'k1' });
    const b = await create({ idempotencyKey: 'k1' });
    expect(a).toMatchObject({ reused: false });
    expect(b).toMatchObject({ reused: true });
    expect(String((b as { job: { _id: unknown } }).job._id)).toBe(String((a as { job: { _id: unknown } }).job._id));
    expect(await DeviceJob.countDocuments()).toBe(1);
  });

  it('claims oldest first, once, and never a job past its claim timeout', async () => {
    await phone();
    const stale = await DeviceJob.create({ machineId: 'host-a', deviceUdid: 'emulator-5554', action: home, requestedBy: 'u1' });
    await backdate(stale._id);
    await create();
    await create();
    const first = await claimNextJob('host-a');
    const second = await claimNextJob('host-a');
    expect(first?.status).toBe('running');
    expect(String(first?._id)).not.toBe(String(stale._id));
    expect(String(second?._id)).not.toBe(String(first?._id));
    expect(await claimNextJob('host-a')).toBeNull();
    expect(await claimNextJob('host-b')).toBeNull();
  });

  it('a waiting agent is woken by a new job instead of waiting out the poll', async () => {
    await phone();
    const started = Date.now();
    const waiting = waitForJob('host-a', 10_000);
    await new Promise((r) => setTimeout(r, 100));
    await create();
    const job = await waiting;
    expect(job?.status).toBe('running');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('accepts a late result, repeats are no-ops, a contradicting one is refused; typed text is wiped', async () => {
    await phone();
    await create({ action: { kind: 'text', text: 'hunter2' } });
    const job = await claimNextJob('host-a');
    await DeviceJob.updateOne({ _id: job?._id }, { startedAt: new Date(Date.now() - RUN_TIMEOUT_MS - 1000) });
    await expireDeviceJobs();
    expect((await DeviceJob.findById(job?._id))?.status).toBe('timed_out');

    const done = await reportDeviceJob(String(job?._id), 'host-a', { status: 'succeeded' });
    expect(done).toMatchObject({ status: 'succeeded', late: true });
    expect((done.action as { text: string }).text).toBe('');
    await expect(reportDeviceJob(String(job?._id), 'host-a', { status: 'succeeded' })).resolves.toMatchObject({ status: 'succeeded' });
    await expect(reportDeviceJob(String(job?._id), 'host-a', { status: 'failed' })).rejects.toMatchObject({ code: 'ALREADY_REPORTED' });
    await expect(reportDeviceJob(String(job?._id), 'host-b', { status: 'succeeded' })).rejects.toMatchObject({ code: 'AGENT_MACHINE_MISMATCH' });
  });

  it('times out an unclaimed job and interrupts the jobs of a host that went offline', async () => {
    await phone();
    await create();
    await backdate((await DeviceJob.findOne({}))?._id);
    await DeviceJob.create({ machineId: 'host-b', deviceUdid: 'x', action: home, requestedBy: 'u1', status: 'running', startedAt: new Date() });
    await Host.create({ machineId: 'host-b', hostname: 'b', os: 'linux', agentVersion: '1', status: 'offline' });
    expect(await expireDeviceJobs()).toEqual({ timedOut: 1, interrupted: 1 });
    expect((await DeviceJob.find({}).sort({ machineId: 1 })).map((j) => j.status)).toEqual(['timed_out', 'interrupted']);
  });
});
