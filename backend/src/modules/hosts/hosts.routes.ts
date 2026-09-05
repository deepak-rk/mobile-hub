import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { listHosts, getHost, upsertHeartbeat } from './hosts.service';
import { requireAgentToken } from '../agent-auth/agent-auth';
import { getPendingInstallsForMachine } from '../device-installs/install-runs.service';
import { ForbiddenError, NotFoundError, ValidationError } from '../../common/errors/app-error';

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

  app.post('/heartbeat', { preHandler: requireAgentToken }, async (req) => {
    const body = heartbeatBody.safeParse(req.body);
    if (!body.success) {
      throw new ValidationError(body.error.message);
    }
    // A per-agent credential is scoped to one machineId — that's the entire
    // point of it over the shared AGENT_TOKEN. `agentMachineId` is null for
    // the shared-token path, which stays unrestricted exactly as before.
    if (req.agentMachineId && req.agentMachineId !== body.data.machineId) {
      throw new ForbiddenError('This credential is scoped to a different machineId.', 'AGENT_MACHINE_MISMATCH');
    }
    const host = await upsertHeartbeat(body.data);
    // Piggybacks on the existing 10s poll cycle rather than opening a second
    // one — the agent-polls-for-pending-installs decision this session
    // deliberately avoids inventing any new hub->agent transport.
    const pendingInstalls = await getPendingInstallsForMachine(body.data.machineId);
    return { ...host.toObject(), pendingInstalls };
  });

  app.get('/:machineId', async (req) => {
    const { machineId } = req.params as { machineId: string };
    const host = await getHost(machineId);
    if (!host) throw new NotFoundError('Host not found');
    return host;
  });
};
