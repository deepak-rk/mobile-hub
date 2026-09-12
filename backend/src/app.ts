import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import jwt from '@fastify/jwt';
import websocket from '@fastify/websocket';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
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
import { installRunsRoutes } from './modules/device-installs/install-runs.routes';
import { uninstallRunsRoutes } from './modules/device-installs/uninstall-runs.routes';
import { executionRoutes } from './modules/execution/execution.routes';
import { streamingRoutes } from './modules/streaming/streaming.routes';
import { analyticsRoutes } from './modules/analytics/analytics.routes';
import { AppError } from './common/errors/app-error';

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

  // The one place an AppError becomes an HTTP response — every route below
  // that throws one (rather than catching it and building a reply by hand)
  // is handled here. Anything that isn't an AppError is treated as opaque:
  // logged with the full error for diagnosis, but never handed back to the
  // caller (backend/CLAUDE.md: "Never expose secrets, tokens, stack traces
  // ... in logs or API responses").
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({ code: err.code, message: err.message });
    }
    // Fastify itself and its plugins — @fastify/rate-limit's 429 confirmed by
    // reading its source (node_modules/@fastify/rate-limit/index.js: a plain
    // `Error` with `.statusCode` set, not an AppError), plus built-in cases
    // like a malformed JSON body — throw plain Errors with a `statusCode`
    // (and sometimes `code`) attached, carrying an already-safe, user-facing
    // message. Respect those instead of collapsing every 4xx a plugin raises
    // into a 500; only a genuinely unexpected error (no statusCode, or a 5xx)
    // falls through to the generic response below.
    const pluginError = err as { statusCode?: number; code?: string; message?: string };
    if (typeof pluginError.statusCode === 'number' && pluginError.statusCode >= 400 && pluginError.statusCode < 500) {
      return reply
        .status(pluginError.statusCode)
        .send({ code: pluginError.code ?? 'ERROR', message: pluginError.message ?? 'Request error' });
    }
    req.log.error(err);
    return reply.status(500).send({ code: 'INTERNAL_ERROR', message: 'Something went wrong' });
  });

  // Security plugins
  void app.register(helmet, { contentSecurityPolicy: false });
  void app.register(cors, { origin: env.NODE_ENV === 'development' ? true : false });
  void app.register(rateLimit, { max: env.RATE_LIMIT_MAX, timeWindow: env.RATE_LIMIT_WINDOW });

  // API docs — auto-generated from whatever route metadata actually exists
  // (paths/methods/tags), not the hand-authored docs/api-spec.yaml, which
  // has drifted from the real routes (see docs/TODO.md's "Spec & reference
  // drift" section: /api/execution/runs vs the real /api/execution, etc.).
  // This can never drift the same way because it reads the routes Fastify
  // actually registered. It's necessarily thin on request/response bodies —
  // routes validate with inline `zod.safeParse`, not Fastify's own `schema`
  // option, so there's no per-route schema for @fastify/swagger to surface
  // yet (see docs/TODO.md's "no typed domain error classes" row, the natural
  // place to add real schemas alongside a status-code convention).
  //
  // Registered here, before every route (including fastify-auth-kit's, which
  // register inside an async plugin `await`ed below) — @fastify/swagger
  // discovers routes via an `onRoute` hook, which only fires for routes
  // registered *after* this plugin boots. Registering it any later silently
  // dropped every /api/auth/* route from the generated spec — caught only by
  // actually curling /docs/json and grepping for them, not by anything
  // static.
  void app.register(swagger, {
    openapi: {
      info: {
        title: 'Mobile Hub API',
        version: process.env.npm_package_version ?? '0.0.0',
        description: 'Auto-generated from the live route table. See docs/api-spec.yaml for the fuller (but hand-maintained, occasionally stale) reference.',
      },
      servers: [{ url: `http://localhost:${env.API_PORT}` }],
    },
  });
  void app.register(swaggerUi, { routePrefix: '/docs' });

  // A getter/setter pair, not a plain value, so POST /api/config/reload can
  // actually swap it. Fastify gives each registered plugin an encapsulated
  // instance that inherits decorators through the prototype chain, so a plain
  // `app.config = next` inside the config plugin would define an own property
  // on *that* scope and shadow it — the reload would look like it worked while
  // builds and execution kept reading the config from boot. Assignment walks
  // the prototype chain to this setter instead, so every scope sees one value.
  let current = config;
  app.decorate('config', {
    getter: () => current,
    setter: (next: EffectiveConfig) => {
      current = next;
    },
  });
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

  // Health — wrapped in register() deliberately, not a bare app.get(). Every
  // `void app.register(plugin)` call above only *enqueues* that plugin;
  // avvio doesn't actually run its body until the app boots (`.listen()`/
  // `.ready()`), processing the queue in registration order. A bare
  // `app.get(...)` sitting between two `register()` calls isn't queued at
  // all — it runs immediately, synchronously, as buildApp() executes top to
  // bottom, before any of the plugins registered above it (helmet, cors,
  // rate-limit, swagger) have actually run their bodies. So rate-limit's
  // onRoute hook didn't exist yet when this route registered, silently
  // exempting /health from the global limit — confirmed live (RATE_LIMIT_MAX
  // overridden low, /health never 429'd while /api/hosts correctly did) both
  // before and after the typed-error-classes change, so this predates it.
  // Wrapping the route in its own register() forces it into the same avvio
  // queue, positioned after rate-limit above, so the hook is guaranteed to
  // exist by the time this actually runs.
  void app.register(async (instance) => {
    instance.get('/health', async () => ({ status: 'ok', ts: new Date().toISOString() }));
  });

  // API routes
  void app.register(hostsRoutes, { prefix: '/api/hosts' });
  void app.register(devicesRoutes, { prefix: '/api/devices' });
  void app.register(configRoutes, { prefix: '/api/config' });
  void app.register(agentCredentialsRoutes, { prefix: '/api/agent-credentials' });
  void app.register(buildsRoutes, { prefix: '/api/builds' });
  void app.register(installRunsRoutes, { prefix: '/api/device-installs' });
  void app.register(uninstallRunsRoutes, { prefix: '/api/device-installs/uninstalls' });
  void app.register(executionRoutes, { prefix: '/api/execution' });
  // Streaming hangs off the device resource it belongs to.
  void app.register(streamingRoutes, { prefix: '/api/devices' });
  void app.register(analyticsRoutes, { prefix: '/api/analytics' });

  return app;
}
