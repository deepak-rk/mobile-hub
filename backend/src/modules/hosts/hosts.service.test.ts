import { describe, it, expect, vi, afterEach } from 'vitest';
import { Host } from './host.model';
import { Device } from '../devices/device.model';
import { InstallRun } from '../device-installs/install-run.model';
import { UninstallRun } from '../device-installs/uninstall-run.model';
import { markStaleHostsOffline, upsertHeartbeat } from './hosts.service';

/**
 * A device is only reachable through its host's agent. When that agent dies
 * nothing re-syncs its devices, so without this they sit at `idle` and read as
 * available — someone could lock one, or trigger a run against a machine that
 * isn't there. Found by actually running the agent and watching what the API
 * reported afterwards.
 */
function stub(staleHosts: { machineId: string }[], abandoned = { installs: 0, uninstalls: 0 }) {
  const hostUpdate = vi.fn().mockResolvedValue({ modifiedCount: staleHosts.length });
  const deviceUpdate = vi.fn().mockResolvedValue({ modifiedCount: staleHosts.length * 2 });
  // The agent's own in-flight work, abandoned with it — see the
  // failAbandonedInstallTargets tests below for why this is part of the same
  // sweep rather than a startup task.
  const installUpdate = vi.fn().mockResolvedValue({ modifiedCount: abandoned.installs });
  const uninstallUpdate = vi.fn().mockResolvedValue({ modifiedCount: abandoned.uninstalls });

  vi.spyOn(Host, 'find').mockReturnValue({
    select: () => Promise.resolve(staleHosts),
  } as never);
  vi.spyOn(Host, 'updateMany').mockImplementation(hostUpdate as never);
  vi.spyOn(Device, 'updateMany').mockImplementation(deviceUpdate as never);
  vi.spyOn(InstallRun, 'updateMany').mockImplementation(installUpdate as never);
  vi.spyOn(UninstallRun, 'updateMany').mockImplementation(uninstallUpdate as never);

  return { hostUpdate, deviceUpdate, installUpdate, uninstallUpdate };
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

    await expect(markStaleHostsOffline()).resolves.toEqual({ hosts: 0, devices: 0, abandonedInstalls: 0 });
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

/**
 * Regression for a silent dead-end found 2026-09-22: an agent that died
 * mid-install left its target at `transferring` (or `downloading` /
 * `installing`) forever. The agent only ever picks up `queued` targets, so it
 * was never retried on return, and nothing ever failed it — the install just
 * never finished, with no error anywhere, while `getActiveInstallUdids` kept
 * reporting the device as installing, leaving it showing an "Installing"
 * badge indefinitely *and* marked offline by this very sweep.
 */
describe('markStaleHostsOffline — abandoned install/uninstall targets', () => {
  it('fails the targets an absent agent had started, and reports how many', async () => {
    const { installUpdate, uninstallUpdate } = stub([{ machineId: 'host-1' }], { installs: 2, uninstalls: 1 });

    const result = await markStaleHostsOffline();

    expect(result.abandonedInstalls).toBe(3);
    expect(installUpdate).toHaveBeenCalled();
    expect(uninstallUpdate).toHaveBeenCalled();
  });

  it('never fails a `queued` target — the returning agent still picks those up', async () => {
    const { installUpdate } = stub([{ machineId: 'host-1' }], { installs: 1, uninstalls: 0 });

    await markStaleHostsOffline();

    // The trap this fix had to avoid: `queued` is in-flight for the purposes
    // of the "Installing" badge, but it is also exactly what
    // getPendingInstallsForMachine hands the agent on its next heartbeat.
    // Failing it would convert a recoverable wait into a permanent error.
    const [, , options] = installUpdate.mock.calls[0] as [unknown, unknown, { arrayFilters: { 't.status': { $in: string[] } }[] }];
    const statuses = options.arrayFilters[0]['t.status'].$in;
    expect(statuses).not.toContain('queued');
    expect(statuses).toEqual(
      expect.arrayContaining(['downloading', 'transferring', 'installing', 'granting-permissions']) as string[],
    );
  });

  it('scopes the failure to the stale hosts only — a healthy host keeps installing', async () => {
    const { installUpdate } = stub([{ machineId: 'host-1' }], { installs: 1, uninstalls: 0 });

    await markStaleHostsOffline();

    const [, , options] = installUpdate.mock.calls[0] as [unknown, unknown, { arrayFilters: { 't.machineId': { $in: string[] } }[] }];
    expect(options.arrayFilters[0]['t.machineId'].$in).toEqual(['host-1']);
  });

  it('does no target work at all when every host is healthy', async () => {
    const { installUpdate, uninstallUpdate } = stub([]);

    const result = await markStaleHostsOffline();

    expect(result.abandonedInstalls).toBe(0);
    expect(installUpdate).not.toHaveBeenCalled();
    expect(uninstallUpdate).not.toHaveBeenCalled();
  });
});
