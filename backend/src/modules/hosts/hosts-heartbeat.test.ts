import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { testMongoUri } from '../../common/test-mongo';
import { Host } from './host.model';
import { upsertHeartbeat } from './hosts.service';

/** Against a real MongoDB (MONGO_TEST_URI); skipped without one. CI runs it. */
const uri = testMongoUri('hosts_heartbeat');

describe.runIf(Boolean(uri))('heartbeat metrics and protocol version (MongoDB)', () => {
  beforeAll(async () => {
    await mongoose.connect(uri as string);
  });
  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  beforeEach(async () => {
    await Host.deleteMany({});
  });

  const base = {
    machineId: 'h1',
    hostname: 'h1',
    os: 'linux' as const,
    agentVersion: '1',
    capabilities: { maxDevices: 1, androidSupport: true, iosSupport: false },
  };

  it('stores CPU, memory and the protocol version', async () => {
    await upsertHeartbeat({
      ...base,
      protocolVersion: 1,
      diagnostics: {
        diskFreeBytes: 1,
        diskTotalBytes: 2,
        nodeVersion: 'v22',
        cpuPercent: 37.5,
        cpuCount: 8,
        memTotalBytes: 16e9,
        memFreeBytes: 4e9,
      },
    });
    const host = await Host.findOne({ machineId: 'h1' }).lean();
    expect(host?.protocolVersion).toBe(1);
    expect(host?.diagnostics).toMatchObject({ cpuPercent: 37.5, cpuCount: 8, memTotalBytes: 16e9, memFreeBytes: 4e9 });
  });

  it('stores what an older agent did not send as null, never 0', async () => {
    await upsertHeartbeat({
      ...base,
      protocolVersion: 1,
      diagnostics: { diskFreeBytes: 1, diskTotalBytes: 2, nodeVersion: 'v22', cpuPercent: 10, cpuCount: 2, memTotalBytes: 8, memFreeBytes: 4 },
    });
    await upsertHeartbeat({ ...base, diagnostics: { diskFreeBytes: 1, diskTotalBytes: 2, nodeVersion: 'v18' } });
    const host = await Host.findOne({ machineId: 'h1' }).lean();
    expect(host?.protocolVersion).toBeNull();
    expect(host?.diagnostics).toMatchObject({ cpuPercent: null, cpuCount: null, memTotalBytes: null, memFreeBytes: null });
  });
});
