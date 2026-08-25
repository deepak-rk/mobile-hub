import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import jwt from '@fastify/jwt';
import websocket from '@fastify/websocket';
// Type-only import: guarantees fastify-auth-kit's ambient `declare module
// 'fastify'` augmentation (app.authenticate, app.requireRole, req.user) is
// loaded and merged program-wide, even though the runtime values below are
// loaded via dynamic import (the package is ESM-only; this backend is
// still CommonJS - see docs/LESSONS.md). Erased at compile time, no
// runtime cost.
import type {} from 'fastify-auth-kit';
import { env } from './config/env';
import { EffectiveConfig } from './config/org-config.schema';
import { createUserStore } from './modules/auth/auth.service';
import { hostsRoutes } from './modules/hosts/hosts.routes';
import { devicesRoutes } from './modules/devices/devices.routes';
import { configRoutes } from './modules/config/config.routes';
import { buildsRoutes } from './modules/builds/builds.routes';
import { executionRoutes } from './modules/execution/execution.routes';
import { streamingRoutes } from './modules/streaming/streaming.routes';
import { analyticsRoutes } from './modules/analytics/analytics.routes';

export async function buildApp(config: EffectiveConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      env.NODE_ENV === 'test'
        ? false
        : {
            level: 'info',
            transport:
              env.NODE_ENV === 'development'
                ? { target: 'pino-pretty', options: { colorize: true } }
                : undefined,
          },
  });

  // Security plugins
  void app.register(helmet, { contentSecurityPolicy: false });
  void app.register(cors, { origin: env.NODE_ENV === 'development' ? true : false });
  void app.register(rateLimit, { max: env.RATE_LIMIT_MAX, timeWindow: env.RATE_LIMIT_WINDOW });

  app.decorate('config', config);

  // Auth (fastify-auth-kit)
  void app.register(jwt, { secret: env.JWT_SECRET });
  const { registerAuthDecorators, createAuthRoutes } = await import('fastify-auth-kit');
  app.after(() => registerAuthDecorators(app));
  void app.register(createAuthRoutes(createUserStore()), { prefix: '/api/auth' });

  // WebSocket (execution events, build job progress)
  void app.register(websocket);

  // Health
  app.get('/health', async () => ({ status: 'ok', ts: new Date().toISOString() }));

  // API routes
  void app.register(hostsRoutes, { prefix: '/api/hosts' });
  void app.register(devicesRoutes, { prefix: '/api/devices' });
  void app.register(configRoutes, { prefix: '/api/config' });
  void app.register(buildsRoutes, { prefix: '/api/builds' });
  void app.register(executionRoutes, { prefix: '/api/execution' });
  // Streaming hangs off the device resource it belongs to.
  void app.register(streamingRoutes, { prefix: '/api/devices' });
  void app.register(analyticsRoutes, { prefix: '/api/analytics' });

  return app;
}
