import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { deviceActionSchema } from '../../common/device-actions';
import { ForbiddenError, ValidationError } from '../../common/errors/app-error';
import { requireAgentToken } from '../agent-auth/agent-auth';
import type { IDeviceJob } from './device-job.model';
import {
  createDeviceJob,
  getDeviceJob,
  listDeviceJobs,
  reportDeviceJob,
  waitForJob,
} from './device-jobs.service';

const createBody = z.object({
  deviceUdid: z.string().min(1),
  machineId: z.string().min(1).optional(),
  action: deviceActionSchema,
  dryRun: z.boolean().optional(),
});

const idempotencyHeader = z.string().min(1).max(200).optional();

const nextQuery = z.object({
  machineId: z.string().min(1),
  waitMs: z.coerce.number().int().min(0).max(25_000).default(20_000),
});

const reportBody = z.object({
  status: z.enum(['succeeded', 'failed']),
  output: z.string().optional(),
  error: z.string().optional(),
});

function parse<O>(schema: z.ZodType<O, z.ZodTypeDef, unknown>, value: unknown): O {
  const res = schema.safeParse(value);
  if (!res.success) throw new ValidationError(res.error.message);
  return res.data;
}

/** A job as people see it: never the text that was typed, which may be a password. */
function publicJob(job: IDeviceJob): Record<string, unknown> {
  const o = job.toObject() as Record<string, unknown> & { action: Record<string, unknown> };
  if (o.action.kind === 'text') o.action = { kind: 'text' };
  delete o.idempotencyKey;
  return o;
}

function assertSameHost(agentMachineId: string | null, machineId: string | undefined): void {
  if (agentMachineId && machineId && agentMachineId !== machineId) {
    throw new ForbiddenError('This credential is scoped to a different machineId.', 'AGENT_MACHINE_MISMATCH');
  }
}

export const deviceJobsRoutes: FastifyPluginAsync = async (app) => {
  // Press, tap, swipe, type, rotate, reboot. `dryRun: true` runs every check
  // (device held by you, not busy, supported) without sending anything.
  app.post('/', { preHandler: app.requireRole('operator', 'admin') }, async (req, reply) => {
    const body = parse(createBody, req.body);
    const idempotencyKey = parse(idempotencyHeader, req.headers['idempotency-key']);
    const result = await createDeviceJob({ ...body, userId: req.user.sub, idempotencyKey });
    if ('dryRun' in result) return result;
    return reply.code(result.reused ? 200 : 201).send(publicJob(result.job));
  });

  app.get('/', { preHandler: app.authenticate }, async (req) => {
    const q = parse(z.object({ deviceUdid: z.string().min(1), machineId: z.string().min(1).optional() }), req.query);
    return (await listDeviceJobs(q.deviceUdid, q.machineId)).map(publicJob);
  });

  // The agent's long-poll: the next job for its host, claimed, or 204 after waitMs.
  app.get('/next', { preHandler: requireAgentToken }, async (req, reply) => {
    const q = parse(nextQuery, req.query);
    assertSameHost(req.agentMachineId, q.machineId);
    const job = await waitForJob(q.machineId, q.waitMs);
    if (!job) return reply.code(204).send();
    return { _id: job._id, deviceUdid: job.deviceUdid, action: job.action };
  });

  app.get('/:id', { preHandler: app.authenticate }, async (req) => {
    const { id } = req.params as { id: string };
    return publicJob(await getDeviceJob(id));
  });

  app.post('/:id/report', { preHandler: requireAgentToken }, async (req) => {
    const { id } = req.params as { id: string };
    const { machineId } = req.query as { machineId?: string };
    assertSameHost(req.agentMachineId, machineId);
    const body = parse(reportBody, req.body);
    return publicJob(await reportDeviceJob(id, req.agentMachineId ?? machineId ?? null, body));
  });
};
