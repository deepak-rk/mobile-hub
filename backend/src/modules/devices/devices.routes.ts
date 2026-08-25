import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { acquireLock, getDevice, listDevices, releaseLock, syncDevices } from './devices.service';
import { requireAgentToken } from '../agent-auth/agent-auth';

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
    return listDevices({ platform, status, machineId });
  });

  app.post('/sync', { preHandler: requireAgentToken }, async (req, reply) => {
    const body = syncBody.safeParse(req.body);
    if (!body.success) {
      return reply.status(400).send({ code: 'VALIDATION_ERROR', message: body.error.message });
    }
    return syncDevices(body.data.machineId, body.data.devices);
  });

  app.get('/:udid', async (req, reply) => {
    const { udid } = req.params as { udid: string };
    const device = await getDevice(udid);
    if (!device) return reply.status(404).send({ code: 'NOT_FOUND', message: 'Device not found' });
    return device;
  });

  app.post('/:udid/lock', { preHandler: app.authenticate }, async (req, reply) => {
    const { udid } = req.params as { udid: string };
    const { reason } = (req.body as { reason?: string }) ?? {};
    const sessionId = `session-${Date.now()}`;
    const device = await acquireLock(udid, req.user.sub, sessionId, reason);
    if (!device) {
      return reply.status(409).send({ code: 'DEVICE_LOCKED', message: 'Device is already locked' });
    }
    return device;
  });

  app.post('/:udid/unlock', { preHandler: app.authenticate }, async (req, reply) => {
    const { udid } = req.params as { udid: string };
    const isAdmin = req.user.role === 'admin';
    const device = await releaseLock(udid, req.user.sub, isAdmin);
    if (!device) {
      return reply.status(403).send({ code: 'FORBIDDEN', message: 'Cannot release a lock you do not hold' });
    }
    return device;
  });
};
