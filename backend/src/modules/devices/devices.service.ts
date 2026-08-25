import { Device, IDevice } from './device.model';

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
