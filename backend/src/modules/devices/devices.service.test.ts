import { describe, it, expect, vi, afterEach } from 'vitest';
import { Device } from './device.model';
import { syncDevices, acquireLock, releaseLock } from './devices.service';

/**
 * `syncDevices` used to force-set `status:'idle'` on every rediscovered
 * device, even one currently locked — a routine re-sync while in-use
 * silently wiped the "in use" status while leaving the lock subdocument
 * intact. Fixed by never touching `status` on upsert except the explicit
 * offline->idle reconnect update. These pin that behaviour directly against
 * the Mongoose calls, since the fix is entirely about what `syncDevices`
 * does NOT put in its update document.
 */
afterEach(() => {
  vi.restoreAllMocks();
});

describe('syncDevices', () => {
  it('upserts discovered devices without ever setting `status`', async () => {
    const findOneAndUpdate = vi.fn().mockResolvedValue({});
    vi.spyOn(Device, 'findOneAndUpdate').mockImplementation(findOneAndUpdate as never);
    vi.spyOn(Device, 'updateMany').mockResolvedValue({ modifiedCount: 0 } as never);

    await syncDevices('host-1', [
      { udid: 'd1', platform: 'android', name: 'Pixel', osVersion: '14', model: 'Pixel 7', connectionType: 'usb' },
    ]);

    expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
    const [, update] = findOneAndUpdate.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(update).not.toHaveProperty('status');
  });

  it('flips a reconnected device from offline back to idle', async () => {
    vi.spyOn(Device, 'findOneAndUpdate').mockResolvedValue({} as never);
    const updateMany = vi.fn().mockResolvedValue({ modifiedCount: 0 });
    vi.spyOn(Device, 'updateMany').mockImplementation(updateMany as never);

    await syncDevices('host-1', [
      { udid: 'd1', platform: 'android', name: 'Pixel', osVersion: '14', model: 'Pixel 7', connectionType: 'usb' },
    ]);

    expect(updateMany).toHaveBeenNthCalledWith(
      1,
      { machineId: 'host-1', udid: { $in: ['d1'] }, status: 'offline' },
      { status: 'idle' },
    );
  });

  it('marks devices no longer reported as offline and releases their lock', async () => {
    vi.spyOn(Device, 'findOneAndUpdate').mockResolvedValue({} as never);
    const updateMany = vi.fn().mockResolvedValue({ modifiedCount: 1 });
    vi.spyOn(Device, 'updateMany').mockImplementation(updateMany as never);

    const result = await syncDevices('host-1', []);

    expect(updateMany).toHaveBeenNthCalledWith(
      2,
      { machineId: 'host-1', udid: { $nin: [] }, status: { $ne: 'offline' } },
      { status: 'offline', isLocallyReachable: false, lock: null },
    );
    expect(result.markedOffline).toBe(1);
  });

  it('does not touch status or lock for a device that stays known and online', async () => {
    // Regression: a routine re-sync of a locked device must leave
    // status:'in-use' and its lock subdocument untouched.
    const findOneAndUpdate = vi.fn().mockResolvedValue({});
    vi.spyOn(Device, 'findOneAndUpdate').mockImplementation(findOneAndUpdate as never);
    vi.spyOn(Device, 'updateMany').mockResolvedValue({ modifiedCount: 0 } as never);

    await syncDevices('host-1', [
      { udid: 'd1', platform: 'android', name: 'Pixel', osVersion: '14', model: 'Pixel 7', connectionType: 'usb' },
    ]);

    const [, update] = findOneAndUpdate.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(update).not.toHaveProperty('status');
    expect(update).not.toHaveProperty('lock');
  });
});

describe('acquireLock', () => {
  it('only succeeds if no lock currently exists (atomic filter)', async () => {
    const findOneAndUpdate = vi.fn().mockResolvedValue(null);
    vi.spyOn(Device, 'findOneAndUpdate').mockImplementation(findOneAndUpdate as never);

    const result = await acquireLock('d1', 'user-1', 'sess-1', 'testing');

    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { udid: 'd1', lock: null },
      expect.objectContaining({ status: 'in-use' }),
      { new: true },
    );
    // Mongo returning null means the atomic filter didn't match (already locked).
    expect(result).toBeNull();
  });
});

describe('releaseLock', () => {
  it('a non-admin can only release their own lock', async () => {
    const findOneAndUpdate = vi.fn().mockResolvedValue({});
    vi.spyOn(Device, 'findOneAndUpdate').mockImplementation(findOneAndUpdate as never);

    await releaseLock('d1', 'user-1', false);

    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { udid: 'd1', 'lock.heldBy': 'user-1' },
      { lock: null, status: 'idle' },
      { new: true },
    );
  });

  it('an admin can release any lock regardless of owner', async () => {
    const findOneAndUpdate = vi.fn().mockResolvedValue({});
    vi.spyOn(Device, 'findOneAndUpdate').mockImplementation(findOneAndUpdate as never);

    await releaseLock('d1', 'admin-1', true);

    expect(findOneAndUpdate).toHaveBeenCalledWith({ udid: 'd1' }, { lock: null, status: 'idle' }, { new: true });
  });
});
