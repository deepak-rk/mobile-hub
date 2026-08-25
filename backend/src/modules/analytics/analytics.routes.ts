import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { computeDailyAggregates, queryAggregates } from './analytics.service';

const listQuery = z.object({
  project: z.string().optional(),
  platform: z.enum(['android', 'ios', 'all']).optional(),
  window: z.enum(['daily', 'weekly']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

const recomputeBody = z.object({
  date: z.coerce.date().optional(),
});

export const analyticsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async (req, reply) => {
    const query = listQuery.safeParse(req.query);
    if (!query.success) {
      return reply.status(400).send({ code: 'VALIDATION_ERROR', message: query.error.message });
    }
    return queryAggregates(query.data);
  });

  app.post('/recompute', { preHandler: app.requireRole('operator', 'admin') }, async (req, reply) => {
    const body = recomputeBody.safeParse(req.body ?? {});
    if (!body.success) {
      return reply.status(400).send({ code: 'VALIDATION_ERROR', message: body.error.message });
    }
    const aggregates = await computeDailyAggregates(body.data.date);
    return { computed: aggregates.length, aggregates };
  });
};
