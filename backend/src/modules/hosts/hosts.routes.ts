import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { listHosts, getHost, upsertHeartbeat } from './hosts.service';
import { requireAgentToken } from '../agent-auth/agent-auth';

const heartbeatBody = z.object({
  machineId: z.string().min(1),
  hostname: z.string().min(1),
  os: z.enum(['darwin', 'linux', 'win32']),
  agentVersion: z.string().min(1),
  capabilities: z.object({
    maxDevices: z.number().int().nonnegative(),
    androidSupport: z.boolean(),
    iosSupport: z.boolean(),
  }),
});

export const hostsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async () => {
    return listHosts();
  });

  app.post('/heartbeat', { preHandler: requireAgentToken }, async (req, reply) => {
    const body = heartbeatBody.safeParse(req.body);
    if (!body.success) {
      return reply.status(400).send({ code: 'VALIDATION_ERROR', message: body.error.message });
    }
    const host = await upsertHeartbeat(body.data);
    return host;
  });

  app.get('/:machineId', async (req, reply) => {
    const { machineId } = req.params as { machineId: string };
    const host = await getHost(machineId);
    if (!host) return reply.status(404).send({ code: 'NOT_FOUND', message: 'Host not found' });
    return host;
  });
};
