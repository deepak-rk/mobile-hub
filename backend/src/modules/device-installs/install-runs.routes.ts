import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { WebSocket } from 'ws';
import type { JwtPayload } from 'fastify-auth-kit';
import {
  BuildNotReadyError,
  IncompatibleDeviceError,
  UnknownDeviceError,
  getInstallRun,
  listInstallRuns,
  reportTargetProgress,
  triggerInstallRun,
} from './install-runs.service';
import { subscribeToInstallEvents } from './install-runs.events';
import { requireAgentToken } from '../agent-auth/agent-auth';

const triggerBody = z.object({
  buildId: z.string().min(1),
  deviceUdids: z.array(z.string().min(1)).min(1),
});

const reportBody = z.object({
  status: z.enum(['queued', 'downloading', 'installing', 'done', 'error']),
  progress: z.number().min(0).max(100).optional(),
  error: z.string().optional(),
});

export const installRunsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async (req) => {
    const { project, deviceUdid } = req.query as Record<string, string>;
    return listInstallRuns({ project, deviceUdid });
  });

  app.get('/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = await getInstallRun(id);
    if (!run) return reply.status(404).send({ code: 'NOT_FOUND', message: 'Install run not found' });
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
        return reply.status(400).send({ code: 'VALIDATION_ERROR', message: body.error.message });
      }
      try {
        const run = await triggerInstallRun({ ...body.data, triggeredBy: req.user.sub });
        return reply.status(201).send(run);
      } catch (err) {
        if (err instanceof BuildNotReadyError) {
          return reply.status(409).send({ code: 'BUILD_NOT_READY', message: err.message });
        }
        if (err instanceof UnknownDeviceError) {
          return reply.status(400).send({ code: 'UNKNOWN_DEVICE', message: err.message });
        }
        if (err instanceof IncompatibleDeviceError) {
          return reply.status(400).send({ code: 'INCOMPATIBLE_DEVICE', message: err.message });
        }
        throw err;
      }
    },
  );

  // Agent-authenticated: the agent driving one target's download/install
  // reports its own progress here as it goes.
  app.post('/:id/targets/:deviceUdid/report', { preHandler: requireAgentToken }, async (req, reply) => {
    const { id, deviceUdid } = req.params as { id: string; deviceUdid: string };
    const body = reportBody.safeParse(req.body);
    if (!body.success) {
      return reply.status(400).send({ code: 'VALIDATION_ERROR', message: body.error.message });
    }
    const run = await reportTargetProgress(id, deviceUdid, body.data);
    if (!run) return reply.status(404).send({ code: 'NOT_FOUND', message: 'Install run or target not found' });
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
