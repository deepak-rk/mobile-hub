import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { testMongoUri } from '../../common/test-mongo';
import { Host } from './host.model';
import { assertNoMachineIdConflict, fingerprintFrom, upsertHeartbeat } from './hosts.service';

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);

describe('fingerprintFrom', () => {
  it('reads a well-formed header and ignores anything else', () => {
    expect(fingerprintFrom({ 'x-agent-fingerprint': A })).toBe(A);
    expect(fingerprintFrom({})).toBeUndefined();
    expect(fingerprintFrom({ 'x-agent-fingerprint': 'A'.repeat(32) })).toBeUndefined();
    expect(fingerprintFrom({ 'x-agent-fingerprint': [A, B] })).toBeUndefined();
  });
});

/** Against a real MongoDB (MONGO_TEST_URI); skipped without one. CI runs it. */
const uri = testMongoUri('hosts_identity');

describe.runIf(Boolean(uri))('two machines with the same machine id (MongoDB)', () => {
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

  const beat = (fingerprint: string | undefined, hostname = 'box-1') =>
    upsertHeartbeat({
      machineId: 'shared',
      hostname,
      os: 'linux',
      agentVersion: '1',
      capabilities: { maxDevices: 1, androidSupport: true, iosSupport: false },
      fingerprint,
    });
  const quiet = (ms: number) =>
    Host.collection.updateOne({ machineId: 'shared' }, { $set: { lastHeartbeatAt: new Date(Date.now() - ms) } });

  it('refuses a second machine while the first is online, and records it', async () => {
    await beat(A);
    await expect(assertNoMachineIdConflict('shared', B, 'box-2')).rejects.toMatchObject({
      statusCode: 409,
      code: 'MACHINE_ID_CONFLICT',
    });
    const host = await Host.findOne({ machineId: 'shared' });
    expect(host?.fingerprint).toBe(A);
    expect(host?.idConflict?.hostname).toBe('box-2');
  });

  it('lets the same machine back in after a restart', async () => {
    await beat(A);
    await expect(assertNoMachineIdConflict('shared', A, 'box-1')).resolves.toBeUndefined();
  });

  it('lets a replacement machine take the id once the old one has gone quiet', async () => {
    await beat(A);
    await quiet(31_000);
    await expect(assertNoMachineIdConflict('shared', B, 'box-2')).resolves.toBeUndefined();
    await beat(B, 'box-2');
    expect((await Host.findOne({ machineId: 'shared' }))?.fingerprint).toBe(B);
  });

  it('does not check an agent without a fingerprint, and keeps the stored one', async () => {
    await beat(A);
    await expect(assertNoMachineIdConflict('shared', undefined)).resolves.toBeUndefined();
    await beat(undefined);
    expect((await Host.findOne({ machineId: 'shared' }))?.fingerprint).toBe(A);
  });

  it('does not record a conflict from a sync or job poll (no hostname)', async () => {
    await beat(A);
    await expect(assertNoMachineIdConflict('shared', B)).rejects.toMatchObject({ code: 'MACHINE_ID_CONFLICT' });
    expect((await Host.findOne({ machineId: 'shared' }))?.idConflict).toBeNull();
  });

  it('clears a recorded conflict after five minutes without another', async () => {
    await beat(A);
    await expect(assertNoMachineIdConflict('shared', B, 'box-2')).rejects.toThrow();
    await beat(A);
    expect((await Host.findOne({ machineId: 'shared' }))?.idConflict).not.toBeNull();
    await Host.collection.updateOne(
      { machineId: 'shared' },
      { $set: { 'idConflict.at': new Date(Date.now() - 5 * 60_000 - 1000) } },
    );
    await beat(A);
    expect((await Host.findOne({ machineId: 'shared' }))?.idConflict).toBeNull();
  });
});
