import { Device, IDevice } from './device.model';

/** How often releaseExpiredLocks should be polled. */
export const DEVICE_LOCK_SWEEP_INTERVAL_MS = 60_000; // once a minute — a lock TTL is measured in minutes, not seconds

export async function listDevices(filters: {
  platform?: string;
  status?: string;
  machineId?: string;
}): Promise<IDevice[]> {
  const query: Record<string, unknown> = {};
  if (filters.platform) query.platform = filters.platform;
  if (filters.status) query.status = filters.status;
  if (filters.machineId) query.machineId = filters.machineId;
  return Device.find(query).sort({ machineId: 1, name: 1 });
}

export async function getDevice(udid: string): Promise<IDevice | null> {
  return Device.findOne({ udid });
}

export async function syncDevices(
  machineId: string,
  discovered: Array<{
    udid: string;
    platform: IDevice['platform'];
    name: string;
    osVersion: string;
    model: string;
    connectionType: IDevice['connectionType'];
  }>,
): Promise<{ upserted: number; markedOffline: number }> {
  const now = new Date();
  const discoveredUdids = discovered.map((d) => d.udid);

  // Upsert all discovered devices. Deliberately does NOT set `status` here:
  // a device already locked (in-use) must keep that status across a routine
  // re-sync, and a brand-new device gets 'idle' from the schema default.
  await Promise.all(
    discovered.map((d) =>
      Device.findOneAndUpdate(
        { machineId, udid: d.udid },
        { ...d, machineId, isLocallyReachable: true, lastSeenAt: now },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      ),
    ),
  );

  // A device that was offline and is now reachable again goes back to idle
  // (offline devices never hold a lock — see the offline-marking below).
  await Device.updateMany({ machineId, udid: { $in: discoveredUdids }, status: 'offline' }, { status: 'idle' });

  // Mark devices no longer seen as offline, and release any lock they held —
  // a device that dropped off its host must not stay locked forever.
  const offlineResult = await Device.updateMany(
    { machineId, udid: { $nin: discoveredUdids }, status: { $ne: 'offline' } },
    { status: 'offline', isLocallyReachable: false, lock: null },
  );

  return { upserted: discovered.length, markedOffline: offlineResult.modifiedCount };
}

export async function acquireLock(
  udid: string,
  userId: string,
  sessionId: string,
  reason?: string,
): Promise<IDevice | null> {
  // Atomic: only succeeds if lock is currently null
  return Device.findOneAndUpdate(
    { udid, lock: null },
    {
      lock: { heldBy: userId, sessionId, acquiredAt: new Date(), reason },
      status: 'in-use',
    },
    { new: true },
  );
}

export async function releaseLock(udid: string, userId: string, isAdmin: boolean): Promise<IDevice | null> {
  const filter = isAdmin ? { udid } : { udid, 'lock.heldBy': userId };
  return Device.findOneAndUpdate(filter, { lock: null, status: 'idle' }, { new: true });
}

/**
 * Renews a held lock's TTL clock by resetting `acquiredAt` to now — the lock
 * itself is unchanged (still `in-use`, same holder), only how much longer it
 * survives the sweep below. Same owner-or-admin rule as `releaseLock`: the
 * two are the only ways a lock's lifecycle can be affected by its holder.
 */
export async function renewLock(udid: string, userId: string, isAdmin: boolean): Promise<IDevice | null> {
  const filter = isAdmin ? { udid, lock: { $ne: null } } : { udid, 'lock.heldBy': userId };
  return Device.findOneAndUpdate(filter, { 'lock.acquiredAt': new Date() }, { new: true });
}

/**
 * Releases locks that have outlived `lockTtlMinutes` since they were last
 * acquired or renewed — the *online* counterpart to
 * `hosts.service.ts#markStaleHostsOffline`, which already handles a device
 * going offline entirely. This is the case that was still missing: the
 * device keeps heartbeating, but the client holding the lock crashed or was
 * simply left open, and nothing was releasing it except an admin
 * force-unlock.
 *
 * `ttlMinutes: null` disables expiry entirely (the pre-2026-08-27 default
 * behaviour) — every lock survives until explicit unlock or the device going
 * offline, same as before this feature existed.
 */
export async function releaseExpiredLocks(ttlMinutes: number | null): Promise<number> {
  if (ttlMinutes == null) return 0;

  const cutoff = new Date(Date.now() - ttlMinutes * 60_000);
  const result = await Device.updateMany(
    { lock: { $ne: null }, 'lock.acquiredAt': { $lt: cutoff } },
    { lock: null, status: 'idle' },
  );
  return result.modifiedCount;
}
