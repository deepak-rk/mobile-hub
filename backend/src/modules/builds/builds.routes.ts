import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getBuild, listBuilds, triggerBuildFetch } from './builds.service';

const triggerBody = z.object({
  project: z.string().min(1),
  platform: z.enum(['android', 'ios']),
  version: z.string().min(1),
  artifactUrl: z.string().url().optional(),
});

export const buildsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async (req) => {
    const { project, platform } = req.query as Record<string, string>;
    return listBuilds({ project, platform });
  });

  app.get('/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const build = await getBuild(id);
    if (!build) return reply.status(404).send({ code: 'NOT_FOUND', message: 'Build not found' });
    return build;
  });

  app.post(
    '/',
    {
      preHandler: app.requireRole('operator', 'admin'),
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const body = triggerBody.safeParse(req.body);
      if (!body.success) {
        return reply.status(400).send({ code: 'VALIDATION_ERROR', message: body.error.message });
      }
      if (app.config.build.provider === 'url' && !body.data.artifactUrl) {
        return reply
          .status(400)
          .send({ code: 'VALIDATION_ERROR', message: "artifactUrl is required when build.provider is 'url'" });
      }
      try {
        const build = await triggerBuildFetch(app.config, body.data);
        return reply.status(201).send(build);
      } catch (err) {
        req.log.error(err, 'Build fetch failed');
        return reply
          .status(502)
          .send({ code: 'BUILD_FETCH_FAILED', message: err instanceof Error ? err.message : 'Build fetch failed' });
      }
    },
  );
};
