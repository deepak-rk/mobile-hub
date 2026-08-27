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
import type * as FastifyAuthKit from 'fastify-auth-kit';
import { env } from './config/env';
import { EffectiveConfig } from './config/org-config.schema';
import { createUserStore } from './modules/auth/auth.service';
import dynamicImport from './common/dynamic-import';
import { createAuthRateLimiter } from './common/auth-rate-limit';
import { hostsRoutes } from './modules/hosts/hosts.routes';
import { devicesRoutes } from './modules/devices/devices.routes';
import { agentCredentialsRoutes } from './modules/agent-credentials/agent-credentials.routes';
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
  // Default null so a request that never reaches requireAgentToken still
  // has a defined value, not undefined.
  app.decorateRequest('agentMachineId', null);

  // Auth (fastify-auth-kit)
  void app.register(jwt, { secret: env.JWT_SECRET });
  const { registerAuthDecorators, createAuthRoutes } =
    await dynamicImport<typeof FastifyAuthKit>('fastify-auth-kit');
  app.after(() => registerAuthDecorators(app));

  // fastify-auth-kit owns POST /register, POST /login and GET /me's route
  // definitions internally — AuthRoutesOptions has no rate-limit passthrough.
  // A tighter, independent limit for just register/login (see
  // common/auth-rate-limit.ts for why it isn't built on @fastify/rate-limit's
  // own decorator) is applied as a preHandler scoped to this child plugin, so
  // it reaches only these routes and nothing else in the app. GET /me is
  // deliberately excluded: it needs a valid JWT already, so it isn't
  // brute-forceable the way credentials are, and the frontend calls it on
  // every page load — tightening it too would risk a shared office IP
  // getting locked out of normal use.
  const authRateLimit = createAuthRateLimiter(env.AUTH_RATE_LIMIT_MAX, env.AUTH_RATE_LIMIT_WINDOW_MS);
  void app.register(async (authScope) => {
    authScope.addHook('preHandler', async (req, reply) => {
      if (req.method === 'POST' && (req.url.endsWith('/register') || req.url.endsWith('/login'))) {
        await authRateLimit(req, reply);
      }
    });
    await authScope.register(createAuthRoutes(createUserStore()), { prefix: '/api/auth' });
  });

  // WebSocket (execution events, build job progress)
  void app.register(websocket);

  // Health
  app.get('/health', async () => ({ status: 'ok', ts: new Date().toISOString() }));

  // API routes
  void app.register(hostsRoutes, { prefix: '/api/hosts' });
  void app.register(devicesRoutes, { prefix: '/api/devices' });
  void app.register(configRoutes, { prefix: '/api/config' });
  void app.register(agentCredentialsRoutes, { prefix: '/api/agent-credentials' });
  void app.register(buildsRoutes, { prefix: '/api/builds' });
  void app.register(executionRoutes, { prefix: '/api/execution' });
  // Streaming hangs off the device resource it belongs to.
  void app.register(streamingRoutes, { prefix: '/api/devices' });
  void app.register(analyticsRoutes, { prefix: '/api/analytics' });

  return app;
}
