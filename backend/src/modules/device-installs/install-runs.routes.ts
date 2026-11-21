import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { WebSocket } from 'ws';
import type { JwtPayload } from 'fastify-auth-kit';
import {
  getInstallRun,
  getInstalledDevicesForBuild,
  listInstallRuns,
  reportTargetProgress,
  triggerInstallRun,
} from './install-runs.service';
import { subscribeToInstallEvents } from './install-runs.events';
import { requireAgentToken, AGENT_TRAFFIC_LOG_LEVEL } from '../agent-auth/agent-auth';
import { NotFoundError, ValidationError } from '../../common/errors/app-error';

const triggerBody = z.object({
  buildId: z.string().min(1),
  deviceUdids: z.array(z.string().min(1)).min(1),
});

const reportBody = z.object({
  status: z.enum(['queued', 'downloading', 'transferring', 'installing', 'granting-permissions', 'done', 'error']),
  progress: z.number().min(0).max(100).optional(),
  error: z.string().optional(),
  packageName: z.string().optional(),
});

export const installRunsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async (req) => {
    const { project, deviceUdid } = req.query as Record<string, string>;
    return listInstallRuns({ project, deviceUdid });
  });

  /**
   * Devices that currently hold this build. Registered before `/:id` so the
   * literal `builds` segment can't be read as an install-run id.
   *
   * Lives here rather than under `/api/builds` because the answer comes
   * entirely from install-run history — the `Build` record itself knows
   * nothing about which devices received it.
   */
  app.get('/builds/:buildId/devices', async (req) => {
    const { buildId } = req.params as { buildId: string };
    return getInstalledDevicesForBuild(buildId);
  });

  app.get('/:id', async (req) => {
    const { id } = req.params as { id: string };
    const run = await getInstallRun(id);
    if (!run) throw new NotFoundError('Install run not found');
    return run;
  });

  app.post(
    '/',
    {
      preHandler: app.requireRole('operator', 'admin'),
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const body = triggerBody.safeParse(req.body);
      if (!body.success) {
        throw new ValidationError(body.error.message);
      }
      // BuildNotReadyError / UnknownDeviceError / IncompatibleDeviceError are
      // typed AppErrors now — the global error handler maps them, so no local
      // catch is needed.
      const run = await triggerInstallRun({ ...body.data, triggeredBy: req.user.sub });
      return reply.status(201).send(run);
    },
  );

  // Agent-authenticated: the agent driving one target's download/install
  // reports its own progress here as it goes.
  app.post('/:id/targets/:deviceUdid/report', { preHandler: requireAgentToken, logLevel: AGENT_TRAFFIC_LOG_LEVEL }, async (req) => {
    const { id, deviceUdid } = req.params as { id: string; deviceUdid: string };
    const body = reportBody.safeParse(req.body);
    if (!body.success) {
      throw new ValidationError(body.error.message);
    }
    const run = await reportTargetProgress(id, deviceUdid, body.data);
    if (!run) throw new NotFoundError('Install run or target not found');
    return run;
  });

  // Same ?token= JWT-verify pattern as execution.routes.ts's stream endpoint.
  app.get('/:id/stream', { websocket: true }, (socket: WebSocket, req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    const { token } = req.query as { token?: string };

    if (!token) {
      socket.close(4001, 'Missing token');
      return;
    }
    try {
      app.jwt.verify<JwtPayload>(token);
    } catch {
      socket.close(4001, 'Invalid token');
      return;
    }

    const unsubscribe = subscribeToInstallEvents(id, (event) => {
      socket.send(JSON.stringify(event));
    });
    socket.on('close', unsubscribe);
  });
};
