import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose, { Types } from 'mongoose';
import { testMongoUri } from '../../common/test-mongo';
import { Device } from '../devices/device.model';
import { DeviceJob } from '../device-jobs/device-job.model';
import { InstallRun } from '../device-installs/install-run.model';
import { Host } from './host.model';
import { assertHostNotBlocked, blockHost, unblockHost, upsertHeartbeat } from './hosts.service';

/** Against a real MongoDB (MONGO_TEST_URI); skipped without one. CI runs it. */
const uri = testMongoUri('hosts');

describe.runIf(Boolean(uri))('blocking a host (MongoDB)', () => {
  beforeAll(async () => {
    await mongoose.connect(uri as string);
  });
  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  beforeEach(async () => {
    await Promise.all([Host.deleteMany({}), Device.deleteMany({}), DeviceJob.deleteMany({}), InstallRun.deleteMany({})]);
  });

  const beat = (machineId = 'host-a') =>
    upsertHeartbeat({
      machineId,
      hostname: machineId,
      os: 'linux',
      agentVersion: '1',
      capabilities: { maxDevices: 1, androidSupport: true, iosSupport: false },
    });

  async function seed() {
    await beat();
    await beat('host-b');
    for (const machineId of ['host-a', 'host-b']) {
      await Device.create({
        udid: 'emulator-5554',
        machineId,
        platform: 'android',
        name: 'Pixel',
        osVersion: '14',
        model: 'sdk',
        connectionType: 'emulator',
        status: 'in-use',
        lock: { heldBy: 'u1', sessionId: 's', acquiredAt: new Date() },
      });
    }
    await InstallRun.create({
      buildId: new Types.ObjectId(),
      project: 'p',
      platform: 'android',
      triggeredBy: 'u1',
      targets: [
        { deviceUdid: 'emulator-5554', machineId: 'host-a', status: 'queued', progress: 0 },
        { deviceUdid: 'emulator-5554', machineId: 'host-b', status: 'queued', progress: 0 },
      ],
    });
    await DeviceJob.create({ machineId: 'host-a', deviceUdid: 'emulator-5554', action: { kind: 'key', key: 'home' }, requestedBy: 'u1' });
  }

  it('lets go of everything the host held, and nothing another host held', async () => {
    await seed();
    const res = await blockHost('host-a', 'admin-1', 'decommissioned');
    expect(res.devices).toBe(1);
    expect(res.host.blocked).toMatchObject({ by: 'admin-1', reason: 'decommissioned' });

    const devices = await Device.find({}).sort({ machineId: 1 }).lean();
    expect(devices.map((d) => [d.machineId, d.status, d.lock === null])).toEqual([
      ['host-a', 'offline', true],
      ['host-b', 'in-use', false],
    ]);
    const run = await InstallRun.findOne({}).lean();
    expect(run?.targets.map((t) => t.status)).toEqual(['error', 'queued']);
    expect((await DeviceJob.findOne({}).lean())?.status).toBe('interrupted');
  });

  it('refuses the blocked host until it is unblocked, then lets it back in', async () => {
    await seed();
    await blockHost('host-a', 'admin-1');
    await expect(assertHostNotBlocked('host-a')).rejects.toMatchObject({ code: 'AGENT_BLOCKED', statusCode: 403 });
    await expect(assertHostNotBlocked('host-b')).resolves.toBeUndefined();
    await expect(assertHostNotBlocked('never-seen')).resolves.toBeUndefined();

    await unblockHost('host-a');
    await expect(assertHostNotBlocked('host-a')).resolves.toBeUndefined();
    expect((await beat()).status).toBe('online');
  });

  it('a host that is not registered cannot be blocked', async () => {
    await expect(blockHost('nope', 'admin-1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
