import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { listHosts, getHost, upsertHeartbeat } from './hosts.service';
import { requireAgentToken } from '../agent-auth/agent-auth';
import { getPendingInstallsForMachine, getActiveInstallCountForMachine } from '../device-installs/install-runs.service';
import { getPendingUninstallsForMachine, getActiveUninstallCountForMachine } from '../device-installs/uninstall-runs.service';
import { getActiveRunCountForMachine } from '../execution/execution.service';
import { getActiveStreamCountForMachine } from '../streaming/streaming.service';
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
  diagnostics: z
    .object({
      diskFreeBytes: z.number().nonnegative().nullable(),
      diskTotalBytes: z.number().nonnegative().nullable(),
      nodeVersion: z.string().nullable(),
    })
    .optional(),
});

/** Live counts for a host's diagnostics panel — four independent collections, so fetched in parallel. */
async function getActivityForMachine(machineId: string) {
  const [runs, streams, installs, uninstalls] = await Promise.all([
    getActiveRunCountForMachine(machineId),
    getActiveStreamCountForMachine(machineId),
    getActiveInstallCountForMachine(machineId),
    getActiveUninstallCountForMachine(machineId),
  ]);
  return { runs, streams, installs, uninstalls };
}

export const hostsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async () => {
    const hosts = await listHosts();
    return Promise.all(
      hosts.map(async (host) => {
        const activity = await getActivityForMachine(host.machineId);
        return { ...(host.toObject() as Record<string, unknown>), activity };
      }),
    );
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
    // deliberately avoids inventing any new hub->agent transport. Uninstalls
    // ride the same cycle for the same reason.
    const [pendingInstalls, pendingUninstalls] = await Promise.all([
      getPendingInstallsForMachine(body.data.machineId),
      getPendingUninstallsForMachine(body.data.machineId),
    ]);
    return { ...host.toObject(), pendingInstalls, pendingUninstalls };
  });

  app.get('/:machineId', async (req) => {
    const { machineId } = req.params as { machineId: string };
    const host = await getHost(machineId);
    if (!host) throw new NotFoundError('Host not found');
    return { ...host.toObject(), activity: await getActivityForMachine(machineId) };
  });
};
