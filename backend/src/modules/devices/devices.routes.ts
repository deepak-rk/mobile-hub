import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { acquireLock, getDevice, listDevices, releaseLock, renewLock, syncDevices } from './devices.service';
import { requireAgentToken, AGENT_TRAFFIC_LOG_LEVEL } from '../agent-auth/agent-auth';
import { assertHostNotBlocked, assertNoMachineIdConflict, fingerprintFrom } from '../hosts/hosts.service';
import { deviceKey, getActiveInstallDeviceKeys } from '../device-installs/install-runs.service';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../common/errors/app-error';

const syncBody = z.object({
  machineId: z.string().min(1),
  devices: z.array(
    z.object({
      udid: z.string().min(1),
      platform: z.enum(['android', 'ios']),
      name: z.string(),
      osVersion: z.string(),
      model: z.string(),
      connectionType: z.enum(['usb', 'network', 'simulator', 'emulator']),
    }),
  ),
});

// Optional on every device-scoped action below — see devices.service.ts's
// getDevice() doc comment for why supplying it matters (the same UDID can
// exist on two hosts) and why it stays optional (non-breaking: a caller that
// doesn't have it yet keeps today's best-effort udid-only behavior).
const machineIdBody = z.object({ machineId: z.string().min(1).optional() });

export const devicesRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async (req) => {
    const { platform, status, machineId } = req.query as Record<string, string>;
    const [devices, installing] = await Promise.all([
      listDevices({ platform, status, machineId }),
      getActiveInstallDeviceKeys(),
    ]);
    // `activeInstall` is derived per request rather than stored on the device:
    // installs take no lock, so a device's own record legitimately says
    // nothing about them, and duplicating that state onto the device would
    // just create a second thing to keep in sync. See getActiveInstallDeviceKeys.
    return devices.map((d) => ({
      ...(d.toObject() as Record<string, unknown>),
      activeInstall: installing.has(deviceKey(d.machineId, d.udid)),
    }));
  });

  app.post('/sync', { preHandler: requireAgentToken, logLevel: AGENT_TRAFFIC_LOG_LEVEL }, async (req) => {
    const body = syncBody.safeParse(req.body);
    if (!body.success) {
      throw new ValidationError(body.error.message);
    }
    // See hosts.routes.ts's heartbeat handler for why this check exists.
    if (req.agentMachineId && req.agentMachineId !== body.data.machineId) {
      throw new ForbiddenError('This credential is scoped to a different machineId.', 'AGENT_MACHINE_MISMATCH');
    }
    // Otherwise a blocked host's next sync would bring its devices back online.
    await assertHostNotBlocked(body.data.machineId);
    await assertNoMachineIdConflict(body.data.machineId, fingerprintFrom(req.headers));
    return syncDevices(body.data.machineId, body.data.devices);
  });

  app.get('/:udid', async (req) => {
    const { udid } = req.params as { udid: string };
    const { machineId } = req.query as { machineId?: string };
    const [device, installing] = await Promise.all([getDevice(udid, machineId || undefined), getActiveInstallDeviceKeys()]);
    if (!device) throw new NotFoundError('Device not found');
    // Same derived field as the list, so the two never disagree about a device.
    return {
      ...(device.toObject() as Record<string, unknown>),
      activeInstall: installing.has(deviceKey(device.machineId, device.udid)),
    };
  });

  // operator/admin, not merely authenticated: holding a device lock takes it
  // out of service for the whole lab — a queued execution run cannot start
  // against a locked device — and the holder can renew it indefinitely. These
  // three were the only human-facing mutating routes in the codebase guarded
  // by `app.authenticate` alone (found 2026-09-23), which let a read-only
  // `viewer` deny every operator access to any device. Every other action
  // (trigger, cancel, install, uninstall, purge, stream-stop, recompute)
  // already required a role.
  app.post('/:udid/lock', { preHandler: app.requireRole('operator', 'admin') }, async (req) => {
    const { udid } = req.params as { udid: string };
    const body = machineIdBody.extend({ reason: z.string().optional() }).safeParse(req.body ?? {});
    if (!body.success) throw new ValidationError(body.error.message);
    const sessionId = `session-${Date.now()}`;
    const device = await acquireLock(udid, req.user.sub, sessionId, body.data.reason, body.data.machineId);
    if (!device) {
      throw new ConflictError('Device is already locked', 'DEVICE_LOCKED');
    }
    return device;
  });

  // Resets the lock's TTL clock (see devices.service.ts's releaseExpiredLocks)
  // without changing anything else about it. Nothing calls this yet — no
  // frontend wiring in this pass — but the endpoint exists so a lock holder
  // has a real way to say "I'm still using this" once one does.
  app.post('/:udid/lock/renew', { preHandler: app.requireRole('operator', 'admin') }, async (req) => {
    const { udid } = req.params as { udid: string };
    const body = machineIdBody.safeParse(req.body ?? {});
    if (!body.success) throw new ValidationError(body.error.message);
    const isAdmin = req.user.role === 'admin';
    const device = await renewLock(udid, req.user.sub, isAdmin, body.data.machineId);
    if (!device) {
      throw new ForbiddenError('Cannot renew a lock you do not hold');
    }
    return device;
  });

  // Same gate as lock/renew above, for consistency: once only operators can
  // acquire a lock, only operators can hold one. A lock a viewer acquired
  // before this change still clears on its own via `releaseExpiredLocks`
  // (devices.lockTtlMinutes), and an admin can force-unlock it at any time —
  // so nothing becomes permanently stuck. The service layer's own
  // owner-or-admin rule is unchanged and still applies on top of this.
  app.post('/:udid/unlock', { preHandler: app.requireRole('operator', 'admin') }, async (req) => {
    const { udid } = req.params as { udid: string };
    const body = machineIdBody.safeParse(req.body ?? {});
    if (!body.success) throw new ValidationError(body.error.message);
    const isAdmin = req.user.role === 'admin';
    const device = await releaseLock(udid, req.user.sub, isAdmin, body.data.machineId);
    if (!device) {
      throw new ForbiddenError('Cannot release a lock you do not hold');
    }
    return device;
  });
};
