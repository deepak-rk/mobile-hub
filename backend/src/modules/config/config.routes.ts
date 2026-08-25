import { FastifyPluginAsync } from 'fastify';

export const configRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', { preHandler: app.requireRole('admin') }, () => {
    return app.config;
  });
};
