import { describe, it, expect, vi, afterEach } from 'vitest';
import { Host } from './host.model';
import { Device } from '../devices/device.model';
import { markStaleHostsOffline, upsertHeartbeat } from './hosts.service';

/**
 * A device is only reachable through its host's agent. When that agent dies
 * nothing re-syncs its devices, so without this they sit at `idle` and read as
 * available — someone could lock one, or trigger a run against a machine that
 * isn't there. Found by actually running the agent and watching what the API
 * reported afterwards.
 */
function stub(staleHosts: { machineId: string }[]) {
  const hostUpdate = vi.fn().mockResolvedValue({ modifiedCount: staleHosts.length });
  const deviceUpdate = vi.fn().mockResolvedValue({ modifiedCount: staleHosts.length * 2 });

  vi.spyOn(Host, 'find').mockReturnValue({
    select: () => Promise.resolve(staleHosts),
  } as never);
  vi.spyOn(Host, 'updateMany').mockImplementation(hostUpdate as never);
  vi.spyOn(Device, 'updateMany').mockImplementation(deviceUpdate as never);

  return { hostUpdate, deviceUpdate };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('upsertHeartbeat', () => {
  const baseData = {
    machineId: 'host-1',
    hostname: 'host-1.local',
    os: 'linux' as const,
    agentVersion: '1.0.0',
    capabilities: { maxDevices: 4, androidSupport: true, iosSupport: false },
  };

  it('includes diagnostics in the update when the caller sends it', async () => {
    const findOneAndUpdate = vi.spyOn(Host, 'findOneAndUpdate').mockResolvedValue({} as never);
    const diagnostics = { diskFreeBytes: 100, diskTotalBytes: 200, nodeVersion: 'v22.23.2' };

    await upsertHeartbeat({ ...baseData, diagnostics });

    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { machineId: 'host-1' },
      expect.objectContaining({ diagnostics }),
      expect.anything(),
    );
  });

  it('leaves the stored diagnostics untouched when the caller omits it (older agent)', async () => {
    const findOneAndUpdate = vi.spyOn(Host, 'findOneAndUpdate').mockResolvedValue({} as never);

    await upsertHeartbeat(baseData);

    const update = findOneAndUpdate.mock.calls[0][1] as Record<string, unknown>;
    expect(update).not.toHaveProperty('diagnostics');
  });
});

describe('markStaleHostsOffline', () => {
  it('does nothing when every host is still heartbeating', async () => {
    const { hostUpdate, deviceUpdate } = stub([]);

    await expect(markStaleHostsOffline()).resolves.toEqual({ hosts: 0, devices: 0 });
    expect(hostUpdate).not.toHaveBeenCalled();
    expect(deviceUpdate).not.toHaveBeenCalled();
  });

  it('takes a stale host offline', async () => {
    const { hostUpdate } = stub([{ machineId: 'host-1' }]);

    const result = await markStaleHostsOffline();

    expect(result.hosts).toBe(1);
    expect(hostUpdate).toHaveBeenCalledWith({ machineId: { $in: ['host-1'] } }, { status: 'offline' });
  });

  it('takes that host devices offline and releases their locks', async () => {
    const { deviceUpdate } = stub([{ machineId: 'host-1' }]);

    await markStaleHostsOffline();

    expect(deviceUpdate).toHaveBeenCalledWith(
      { machineId: { $in: ['host-1'] }, status: { $ne: 'offline' } },
      { status: 'offline', isLocallyReachable: false, lock: null },
    );
  });

  it('handles several stale hosts in one sweep', async () => {
    const { hostUpdate, deviceUpdate } = stub([{ machineId: 'host-1' }, { machineId: 'host-2' }]);

    const result = await markStaleHostsOffline();
    const bothHosts = { $in: ['host-1', 'host-2'] };

    expect(result.hosts).toBe(2);
    expect(hostUpdate).toHaveBeenCalledWith({ machineId: bothHosts }, { status: 'offline' });
    expect(deviceUpdate).toHaveBeenCalledWith(
      { machineId: bothHosts, status: { $ne: 'offline' } },
      { status: 'offline', isLocallyReachable: false, lock: null },
    );
  });
});
