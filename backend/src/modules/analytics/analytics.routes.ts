import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { computeDailyAggregates, computeWeeklyAggregates, queryAggregates } from './analytics.service';
import { ValidationError } from '../../common/errors/app-error';

const listQuery = z.object({
  project: z.string().optional(),
  platform: z.enum(['android', 'ios', 'all']).optional(),
  window: z.enum(['daily', 'weekly']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
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
