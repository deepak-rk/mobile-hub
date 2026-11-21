import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { listHosts, getHost, upsertHeartbeat } from './hosts.service';
import { requireAgentToken, AGENT_TRAFFIC_LOG_LEVEL } from '../agent-auth/agent-auth';
import { getPendingInstallsForMachine, getActiveInstallCountForMachine } from '../device-installs/install-runs.service';
import { getPendingUninstallsForMachine, getActiveUninstallCountForMachine } from '../device-installs/uninstall-runs.service';
import { getActiveRunCountForMachine } from '../execution/execution.service';
import {
  getActiveStreamCountForMachine,
  getDesiredStreamCapturesForMachine,
  streamingService,
} from '../streaming/streaming.service';
import { getPendingAppiumRequestsForMachine, reportRemoteAppiumReady } from '../execution/appium.service';
import { ForbiddenError, NotFoundError, ValidationError } from '../../common/errors/app-error';

const appiumReadyBody = z.object({
  deviceUdid: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().positive(),
});

const streamFrameQuery = z.object({
  machineId: z.string().min(1),
  deviceUdid: z.string().min(1),
  protocol: z.enum(['mjpeg', 'h264']),
});

const streamErrorBody = z.object({
  deviceUdid: z.string().min(1),
  protocol: z.enum(['mjpeg', 'h264']),
  message: z.string().min(1),
});

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

  app.post('/heartbeat', { preHandler: requireAgentToken, logLevel: AGENT_TRAFFIC_LOG_LEVEL }, async (req) => {
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
    const [pendingInstalls, pendingUninstalls, pendingAppiumRequests, desiredStreamCaptures] = await Promise.all([
      getPendingInstallsForMachine(body.data.machineId, app.config.devices.grantPermissionsOnInstall),
      getPendingUninstallsForMachine(body.data.machineId),
      // Only ever non-empty when appium.remoteEnabled — nothing sets
      // remoteAppiumRequestedAt otherwise, so this is an empty query result,
      // not a behavior change, for every deployment that hasn't opted in.
      getPendingAppiumRequestsForMachine(body.data.machineId),
      // Same as above, for streaming.remoteEnabled — see streaming.service.ts.
      getDesiredStreamCapturesForMachine(body.data.machineId),
    ]);
    return { ...host.toObject(), pendingInstalls, pendingUninstalls, pendingAppiumRequests, desiredStreamCaptures };
  });

  // Agent-reported result for a pendingAppiumRequests entry above — the other
  // half of the same never-pushed-into relay: the agent discovers the
  // request on a heartbeat, starts its own local Appium, then POSTs back here
  // once it's actually answering, same shape as install/uninstall progress
  // reports.
  app.post('/appium-ready', { preHandler: requireAgentToken, logLevel: AGENT_TRAFFIC_LOG_LEVEL }, async (req) => {
    const body = appiumReadyBody.safeParse(req.body);
    if (!body.success) throw new ValidationError(body.error.message);
    const { machineId } = req.query as { machineId?: string };
    if (!machineId) throw new ValidationError('machineId query parameter is required');
    if (req.agentMachineId && req.agentMachineId !== machineId) {
      throw new ForbiddenError('This credential is scoped to a different machineId.', 'AGENT_MACHINE_MISMATCH');
    }
    await reportRemoteAppiumReady(body.data.deviceUdid, machineId, body.data.host, body.data.port);
    return { ok: true };
  });

  // Scoped to this plugin's own encapsulated instance — doesn't leak to any
  // sibling route registered outside hostsRoutes.
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  /**
   * One frame an agent captured locally for a device it owns, relayed here
   * because adb/xcrun ran beside the device (this process never could) — the
   * other half of `getDesiredStreamCapturesForMachine`'s heartbeat entry. See
   * `streaming/sources/agent-relay.source.ts` for the hub-side capture handle
   * this feeds into via `StreamingService#ingestRemoteFrame`.
   *
   * Always 204, accepted or not: a frame arriving just after the hub stopped
   * wanting it (the bounded window before the agent notices on its next
   * heartbeat) is an expected race, not an error worth the agent logging.
   * `bodyLimit` is raised from Fastify's 1MB default — an H264 segment can
   * exceed that.
   */
  app.post(
    '/stream-frame',
    { preHandler: requireAgentToken, logLevel: AGENT_TRAFFIC_LOG_LEVEL, bodyLimit: 10 * 1024 * 1024 },
    async (req, reply) => {
      const parsed = streamFrameQuery.safeParse(req.query);
      if (!parsed.success) throw new ValidationError(parsed.error.message);
      const { machineId, deviceUdid, protocol } = parsed.data;
      if (req.agentMachineId && req.agentMachineId !== machineId) {
        throw new ForbiddenError('This credential is scoped to a different machineId.', 'AGENT_MACHINE_MISMATCH');
      }
      streamingService.ingestRemoteFrame(machineId, deviceUdid, protocol, req.body as Buffer);
      return reply.code(204).send();
    },
  );

  /** Same shape as `/stream-frame`, for an agent reporting its local capture broke. */
  app.post('/stream-error', { preHandler: requireAgentToken, logLevel: AGENT_TRAFFIC_LOG_LEVEL }, async (req, reply) => {
    const body = streamErrorBody.safeParse(req.body);
    if (!body.success) throw new ValidationError(body.error.message);
    const { machineId } = req.query as { machineId?: string };
    if (!machineId) throw new ValidationError('machineId query parameter is required');
    if (req.agentMachineId && req.agentMachineId !== machineId) {
      throw new ForbiddenError('This credential is scoped to a different machineId.', 'AGENT_MACHINE_MISMATCH');
    }
    streamingService.ingestRemoteError(machineId, body.data.deviceUdid, body.data.protocol, body.data.message);
    return reply.code(204).send();
  });

  app.get('/:machineId', async (req) => {
    const { machineId } = req.params as { machineId: string };
    const host = await getHost(machineId);
    if (!host) throw new NotFoundError('Host not found');
    return { ...host.toObject(), activity: await getActivityForMachine(machineId) };
  });
};
