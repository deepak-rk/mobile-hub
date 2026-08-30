import * as fs from 'fs';
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
        const run = await triggerExecutionRun({ ...body.data, triggeredBy: req.user.sub }, app.config.automation);
        return reply.status(201).send(run);
      } catch (err) {
        if (err instanceof DeviceLockedError) {
          return reply.status(409).send({ code: 'DEVICE_LOCKED', message: err.message });
        }
        throw err;
      }
    },
  );

  /**
   * The run's log as stored on disk.
   *
   * The WebSocket below only carries lines emitted while a client is watching,
   * so reopening a finished run showed an empty "Waiting for output…" panel
   * forever even though the whole log was sitting on disk. This serves that
   * file, which is why it now lives under `artifactsPath` rather than inside
   * the workspace that gets deleted when a run ends.
   */
  app.get('/:id/logs', async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = await getExecutionRun(id);
    if (!run) return reply.status(404).send({ code: 'NOT_FOUND', message: 'Execution run not found' });

    // Runs from before durable artifacts existed kept their log inside the
    // workspace; say so plainly rather than 404ing as if the run never had one.
    if (!run.logPath || !fs.existsSync(run.logPath)) {
      return reply
        .status(404)
        .send({ code: 'LOG_UNAVAILABLE', message: 'No log file is stored for this run.' });
    }
    return reply.header('Content-Type', 'text/plain; charset=utf-8').send(fs.createReadStream(run.logPath));
  });

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
