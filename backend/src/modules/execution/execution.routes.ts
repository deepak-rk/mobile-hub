import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { WebSocket } from 'ws';
import {
  cancelExecutionRun,
  DeviceLockedError,
  getExecutionRun,
  listExecutionRuns,
  RunNotCancellableError,
  triggerExecutionRun,
} from './execution.service';
import { subscribeToExecutionEvents } from './execution.events';
import type { JwtPayload } from 'fastify-auth-kit';

const commandSchema = z.object({ command: z.string().min(1), args: z.array(z.string()).default([]) });

const triggerBody = z.object({
  machineId: z.string().min(1),
  deviceUdid: z.string().min(1),
  buildId: z.string().optional(),
  project: z.string().min(1),
  branch: z.string().min(1),
  suite: z.string().min(1),
  setup: commandSchema.optional(),
  run: commandSchema,
});

export const executionRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async (req) => {
    const { project, status, deviceUdid } = req.query as Record<string, string>;
    return listExecutionRuns({ project, status, deviceUdid });
  });

  app.get('/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = await getExecutionRun(id);
    if (!run) return reply.status(404).send({ code: 'NOT_FOUND', message: 'Execution run not found' });
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
        const run = await triggerExecutionRun({ ...body.data, triggeredBy: req.user.sub });
        return reply.status(201).send(run);
      } catch (err) {
        if (err instanceof DeviceLockedError) {
          return reply.status(409).send({ code: 'DEVICE_LOCKED', message: err.message });
        }
        throw err;
      }
    },
  );

  app.post('/:id/cancel', { preHandler: app.requireRole('operator', 'admin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const run = await cancelExecutionRun(id);
      if (!run) return reply.status(404).send({ code: 'NOT_FOUND', message: 'Execution run not found' });
      return { message: 'Cancellation requested', run };
    } catch (err) {
      if (err instanceof RunNotCancellableError) {
        return reply.status(409).send({ code: 'CONFLICT', message: err.message });
      }
      throw err;
    }
  });

  // Auth via ?token= since a plain WS upgrade can't easily carry an
  // Authorization header from a browser client. Verified synchronously
  // before subscribing to anything - an invalid/missing token gets no events.
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

    const unsubscribe = subscribeToExecutionEvents(id, (event) => {
      socket.send(JSON.stringify(event));
    });
    socket.on('close', unsubscribe);
  });
};
