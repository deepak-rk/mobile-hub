import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { acquireLock, getDevice, listDevices, releaseLock, renewLock, syncDevices } from './devices.service';
import { requireAgentToken } from '../agent-auth/agent-auth';
import { getActiveInstallUdids } from '../device-installs/install-runs.service';
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

export const devicesRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async (req) => {
    const { platform, status, machineId } = req.query as Record<string, string>;
    const [devices, installing] = await Promise.all([
      listDevices({ platform, status, machineId }),
      getActiveInstallUdids(),
    ]);
    // `activeInstall` is derived per request rather than stored on the device:
    // installs take no lock, so a device's own record legitimately says
    // nothing about them, and duplicating that state onto the device would
    // just create a second thing to keep in sync. See getActiveInstallUdids.
    return devices.map((d) => ({
      ...(d.toObject() as Record<string, unknown>),
      activeInstall: installing.has(d.udid),
    }));
  });

  app.post('/sync', { preHandler: requireAgentToken }, async (req) => {
    const body = syncBody.safeParse(req.body);
    if (!body.success) {
      throw new ValidationError(body.error.message);
    }
    // See hosts.routes.ts's heartbeat handler for why this check exists.
    if (req.agentMachineId && req.agentMachineId !== body.data.machineId) {
      throw new ForbiddenError('This credential is scoped to a different machineId.', 'AGENT_MACHINE_MISMATCH');
    }
    return syncDevices(body.data.machineId, body.data.devices);
  });

  app.get('/:udid', async (req) => {
    const { udid } = req.params as { udid: string };
    const device = await getDevice(udid);
    if (!device) throw new NotFoundError('Device not found');
    return device;
  });

  app.post('/:udid/lock', { preHandler: app.authenticate }, async (req) => {
    const { udid } = req.params as { udid: string };
    const { reason } = (req.body as { reason?: string }) ?? {};
    const sessionId = `session-${Date.now()}`;
    const device = await acquireLock(udid, req.user.sub, sessionId, reason);
    if (!device) {
      throw new ConflictError('Device is already locked', 'DEVICE_LOCKED');
    }
    return device;
  });

  // Resets the lock's TTL clock (see devices.service.ts's releaseExpiredLocks)
  // without changing anything else about it. Nothing calls this yet — no
  // frontend wiring in this pass — but the endpoint exists so a lock holder
  // has a real way to say "I'm still using this" once one does.
  app.post('/:udid/lock/renew', { preHandler: app.authenticate }, async (req) => {
    const { udid } = req.params as { udid: string };
    const isAdmin = req.user.role === 'admin';
    const device = await renewLock(udid, req.user.sub, isAdmin);
    if (!device) {
      throw new ForbiddenError('Cannot renew a lock you do not hold');
    }
    return device;
  });

  app.post('/:udid/unlock', { preHandler: app.authenticate }, async (req) => {
    const { udid } = req.params as { udid: string };
    const isAdmin = req.user.role === 'admin';
    const device = await releaseLock(udid, req.user.sub, isAdmin);
    if (!device) {
      throw new ForbiddenError('Cannot release a lock you do not hold');
    }
    return device;
  });
};
