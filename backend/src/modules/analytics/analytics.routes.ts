import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { computeDailyAggregates, computeFailureReasons, computeWeeklyAggregates, queryAggregates } from './analytics.service';
import { ValidationError } from '../../common/errors/app-error';

const listQuery = z.object({
  project: z.string().optional(),
  platform: z.enum(['android', 'ios', 'all']).optional(),
  window: z.enum(['daily', 'weekly']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

const failureReasonsQuery = z.object({
  project: z.string().optional(),
  platform: z.enum(['android', 'ios', 'all']).optional(),
  suite: z.string().optional(),
  days: z.coerce.number().int().positive().max(365).optional(),
});

const recomputeBody = z.object({
  date: z.coerce.date().optional(),
  // Defaults to 'daily' — unchanged behavior for existing callers that don't
  // pass this.
  window: z.enum(['daily', 'weekly']).optional(),
});

export const analyticsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async (req) => {
    const query = listQuery.safeParse(req.query);
    if (!query.success) {
      throw new ValidationError(query.error.message);
    }
    return queryAggregates(query.data);
  });

  /**
   * Recurring failure reasons across many runs — answers "what fails
   * repeatedly", not "what failed on this one run" (the per-run grouping
   * already on RunDetailPage). Registered as its own route rather than
   * folded into `GET /` because it doesn't share that endpoint's window/date
   * shape — this is always a trailing N-day scan, not a bucketed aggregate.
   */
  app.get('/failures', async (req) => {
    const query = failureReasonsQuery.safeParse(req.query);
    if (!query.success) {
      throw new ValidationError(query.error.message);
    }
    return computeFailureReasons(query.data);
  });

  app.post('/recompute', { preHandler: app.requireRole('operator', 'admin') }, async (req) => {
    const body = recomputeBody.safeParse(req.body ?? {});
    if (!body.success) {
      throw new ValidationError(body.error.message);
    }
    const aggregates =
      body.data.window === 'weekly'
        ? await computeWeeklyAggregates(body.data.date)
        : await computeDailyAggregates(body.data.date);
    return { computed: aggregates.length, aggregates };
  });
};
