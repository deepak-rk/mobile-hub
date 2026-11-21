import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  getUninstallRun,
  listUninstallRuns,
  reportUninstallTargetProgress,
  triggerUninstallRun,
} from './uninstall-runs.service';
import { requireAgentToken, AGENT_TRAFFIC_LOG_LEVEL } from '../agent-auth/agent-auth';
import { NotFoundError, ValidationError } from '../../common/errors/app-error';

const triggerBody = z.object({
  packageName: z.string().min(1),
  project: z.string().min(1),
  // `devices` names the host for each target; bare `deviceUdids` is kept for
  // existing clients and is refused (409) when a udid exists on several hosts.
  deviceUdids: z.array(z.string().min(1)).min(1).optional(),
  devices: z.array(z.object({ udid: z.string().min(1), machineId: z.string().min(1) })).min(1).optional(),
});

const reportBody = z.object({
  status: z.enum(['queued', 'uninstalling', 'done', 'error']),
  error: z.string().optional(),
});

/**
 * Registered at its own `/api/device-installs/uninstalls` prefix, not nested
 * under install-runs.routes.ts's `/:id` — an uninstall run and an install run
 * are different resources with different ids, and sharing one `/:id` route
 * would mean either guessing which collection an id belongs to or a literal
 * `uninstalls` segment risking a collision with a real install-run id (never
 * observed, but not a risk worth taking when a distinct prefix costs nothing).
 */
export const uninstallRunsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async (req) => {
    const { project, deviceUdid } = req.query as Record<string, string>;
    return listUninstallRuns({ project, deviceUdid });
  });

  app.get('/:id', async (req) => {
    const { id } = req.params as { id: string };
    const run = await getUninstallRun(id);
    if (!run) throw new NotFoundError('Uninstall run not found');
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
      if (!body.data.devices && !body.data.deviceUdids) {
        throw new ValidationError('devices (or deviceUdids) is required');
      }
      // UnknownDeviceError is a typed AppError — the global error handler
      // maps it, so no local catch is needed.
      const run = await triggerUninstallRun({
        ...body.data,
        devices: [...(body.data.devices ?? []), ...(body.data.deviceUdids ?? []).map((udid) => ({ udid }))],
        triggeredBy: req.user.sub,
      });
      return reply.status(201).send(run);
    },
  );

  // Agent-authenticated: the agent driving one target's uninstall reports
  // its own progress here, same shape as install-runs.routes.ts's report route.
  app.post('/:id/targets/:deviceUdid/report', { preHandler: requireAgentToken, logLevel: AGENT_TRAFFIC_LOG_LEVEL }, async (req) => {
    const { id, deviceUdid } = req.params as { id: string; deviceUdid: string };
    const body = reportBody.safeParse(req.body);
    if (!body.success) {
      throw new ValidationError(body.error.message);
    }
    const run = await reportUninstallTargetProgress(id, deviceUdid, body.data);
    if (!run) throw new NotFoundError('Uninstall run or target not found');
    return run;
  });
};
