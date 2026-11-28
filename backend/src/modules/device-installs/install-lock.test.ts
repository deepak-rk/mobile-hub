import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose, { Types } from 'mongoose';
import { testMongoUri } from '../../common/test-mongo';
import { Device } from '../devices/device.model';
import { InstallRun } from './install-run.model';
import * as buildsService from '../builds/builds.service';
import { releaseFinishedInstallLocks, reportTargetProgress, triggerInstallRun } from './install-runs.service';

/** Against a real MongoDB (MONGO_TEST_URI); skipped without one. CI runs it. */
const uri = testMongoUri('install_lock');

describe.runIf(Boolean(uri))('installs take the device lock (MongoDB)', () => {
  beforeAll(async () => {
    await mongoose.connect(uri as string);
  });
  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.spyOn(buildsService, 'getBuild').mockResolvedValue({
      _id: new Types.ObjectId(),
      status: 'ready',
      platform: 'android',
      project: 'demo',
    } as never);
    await Promise.all([Device.deleteMany({}), InstallRun.deleteMany({})]);
    for (const udid of ['d1', 'd2']) {
      await Device.create({
        udid,
        machineId: 'host-1',
        platform: 'android',
        name: 'Pixel',
        osVersion: '14',
        model: 'sdk',
        connectionType: 'emulator',
        status: 'idle',
      });
    }
  });

  const lockOf = async (udid: string) => (await Device.findOne({ udid, machineId: 'host-1' }).lean())?.lock ?? null;
  const hold = (udid: string, heldBy: string, reason: string) =>
    Device.updateOne(
      { udid, machineId: 'host-1' },
      { lock: { heldBy, sessionId: reason, acquiredAt: new Date(), reason }, status: 'in-use' },
    );
  const trigger = (devices: string[], extra: { triggeredBy?: string; forRunId?: string } = {}) =>
    triggerInstallRun({
      buildId: 'b1',
      devices: devices.map((udid) => ({ udid, machineId: 'host-1' })),
      triggeredBy: extra.triggeredBy ?? 'alice',
      forRunId: extra.forRunId,
    });

  it('locks a free device for the install and releases it when the install finishes', async () => {
    const run = await trigger(['d1']);
    expect(await lockOf('d1')).toMatchObject({ heldBy: 'alice', sessionId: `install:${String(run._id)}` });
    await reportTargetProgress(String(run._id), 'd1', { status: 'installing', progress: 50 }, 'host-1');
    expect(await lockOf('d1')).not.toBeNull();
    await reportTargetProgress(String(run._id), 'd1', { status: 'done', progress: 100 }, 'host-1');
    expect(await lockOf('d1')).toBeNull();
    expect((await Device.findOne({ udid: 'd1' }).lean())?.status).toBe('idle');
  });

  it('refuses a device in use by a test run', async () => {
    await hold('d1', 'alice', 'execution:run-9');
    await expect(trigger(['d1'])).rejects.toMatchObject({ statusCode: 409, code: 'DEVICE_BUSY' });
    expect(await InstallRun.countDocuments()).toBe(0);
  });

  it('lets the test run holding the device install its own app, without taking the lock', async () => {
    await hold('d1', 'alice', 'execution:run-9');
    await trigger(['d1'], { forRunId: 'run-9' });
    expect(await lockOf('d1')).toMatchObject({ reason: 'execution:run-9' });
  });

  it('refuses a device someone else holds, and allows the person holding it', async () => {
    await hold('d1', 'bob', 'manual');
    await expect(trigger(['d1'])).rejects.toMatchObject({ code: 'DEVICE_BUSY' });
    await trigger(['d1'], { triggeredBy: 'bob' });
    expect(await lockOf('d1')).toMatchObject({ heldBy: 'bob', reason: 'manual' });
  });

  it('refuses a second install while one is in flight', async () => {
    await trigger(['d1']);
    await expect(trigger(['d1'])).rejects.toMatchObject({ code: 'DEVICE_BUSY' });
  });

  it('takes no lock at all when any device in the request is refused', async () => {
    await hold('d2', 'bob', 'manual');
    await expect(trigger(['d1', 'd2'])).rejects.toMatchObject({ code: 'DEVICE_BUSY' });
    expect(await lockOf('d1')).toBeNull();
  });

  it('the sweep releases a lock whose target ended without reporting, and keeps one still in flight', async () => {
    const ended = await trigger(['d1']);
    const live = await trigger(['d2']);
    await InstallRun.updateOne({ _id: ended._id }, { $set: { 'targets.0.status': 'error' } });
    expect(await releaseFinishedInstallLocks()).toBe(1);
    expect(await lockOf('d1')).toBeNull();
    expect(await lockOf('d2')).toMatchObject({ sessionId: `install:${String(live._id)}` });
  });

  it('a progress report renews the lock clock so a long download is not swept by the lock TTL', async () => {
    const run = await trigger(['d1']);
    const old = new Date(Date.now() - 60 * 60_000);
    await Device.updateOne({ udid: 'd1' }, { 'lock.acquiredAt': old });
    await reportTargetProgress(String(run._id), 'd1', { status: 'downloading', progress: 10 }, 'host-1');
    const lock = await lockOf('d1');
    expect(lock?.acquiredAt.getTime()).toBeGreaterThan(old.getTime());
  });
});
