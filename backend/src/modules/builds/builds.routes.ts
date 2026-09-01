import * as fs from 'fs';
import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import type { JwtPayload } from 'fastify-auth-kit';
import { z } from 'zod';
import {
  BuildNotPurgeableError,
  getBuild,
  listBuilds,
  purgeBuildArtifact,
  refetchBuild,
  startBuildFetch,
  triggerBuildFetch,
} from './builds.service';
import { subscribeToBuildEvents } from './builds.events';
import { requireAgentToken } from '../agent-auth/agent-auth';

const triggerBody = z.object({
  project: z.string().min(1),
  platform: z.enum(['android', 'ios']),
  version: z.string().min(1),
  artifactUrl: z.string().url().optional(),
  // Opt-in: return as soon as the build row exists so the caller can watch
  // the transfer, instead of blocking the request until the download ends.
  async: z.boolean().optional(),
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

  // Agent-authenticated, not user-authenticated: the device agent fetches
  // the artifact bytes directly, on behalf of no particular user. Streams
  // rather than buffers — build artifacts run to hundreds of MB.
  app.get('/:id/artifact', { preHandler: requireAgentToken }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const build = await getBuild(id);
    if (!build) return reply.status(404).send({ code: 'NOT_FOUND', message: 'Build not found' });
    if (build.status !== 'ready' || !build.artifactPath) {
      return reply.status(409).send({ code: 'BUILD_NOT_READY', message: `Build is '${build.status}', not 'ready'` });
    }
    const stat = fs.statSync(build.artifactPath);
    return reply
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Length', stat.size)
      .header('Content-Disposition', `attachment; filename="${build.id as string}"`)
      .send(fs.createReadStream(build.artifactPath));
  });

  /**
   * Live fetch progress for one build. Same `?token=` verification as the
   * other streams in this app — a browser WS upgrade can't carry an
   * Authorization header.
   */
  app.get('/:id/stream', { websocket: true }, (socket: WebSocket, req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    const { token } = req.query as { token?: string };

    if (!token) {
      socket.close(4001, 'Missing token');
      return;
    }
    try {
      app.jwt.verify<JwtPayload>(token);
    } catch {
      socket.close(4001, 'Invalid token');
      return;
    }

    const unsubscribe = subscribeToBuildEvents(id, (event) => socket.send(JSON.stringify(event)));
    socket.on('close', unsubscribe);
  });

  /**
   * Removes the local artifact, keeping the record.
   *
   * DELETE on the build would imply the record goes too; it does not — the
   * version stays visible in the catalog and can be re-fetched, which is the
   * same `purged` transition retention already uses.
   */
  app.post('/:id/purge', { preHandler: app.requireRole('operator', 'admin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const build = await purgeBuildArtifact(id);
      if (!build) return reply.status(404).send({ code: 'NOT_FOUND', message: 'Build not found' });
      return build;
    } catch (err) {
      if (err instanceof BuildNotPurgeableError) {
        return reply.status(409).send({ code: 'BUILD_NOT_PURGEABLE', message: err.message });
      }
      throw err;
    }
  });

  /**
   * Re-downloads a purged build's artifact from its original source.
   *
   * A purged build keeps its record — project, version and the URL it came
   * from — so getting the file back needs no new input. Without this, "remove
   * local copy" was effectively permanent and the dialog's promise that it
   * "can be fetched again" was untrue.
   */
  app.post('/:id/refetch', { preHandler: app.requireRole('operator', 'admin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const build = await getBuild(id);
    if (!build) return reply.status(404).send({ code: 'NOT_FOUND', message: 'Build not found' });
    if (build.status === 'ready') {
      return reply.status(409).send({ code: 'ALREADY_READY', message: 'This build is already on disk.' });
    }
    if (!build.artifactUrl) {
      // Nothing records where it came from, so there is nowhere to fetch from.
      return reply
        .status(409)
        .send({ code: 'NO_SOURCE', message: 'This build has no source URL to re-fetch from.' });
    }

    try {
      const refetched = await refetchBuild(app.config, build);
      return refetched;
    } catch (err) {
      req.log.error(err, 'Build re-fetch failed');
      return reply
        .status(502)
        .send({ code: 'BUILD_FETCH_FAILED', message: err instanceof Error ? err.message : 'Build re-fetch failed' });
    }
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
        // Default stays synchronous — the response is the finished, checksummed
        // build, which is what existing callers (and the E2E suite) rely on.
        // `async: true` returns as soon as the row exists so a client can watch
        // the transfer over /:id/stream; awaiting a multi-hundred-MB download
        // leaves no window to observe progress and risks a request timeout.
        if (body.data.async) {
          const { build, completed } = await startBuildFetch(app.config, body.data);
          completed.catch((err: unknown) => {
            // runFetch already recorded 'corrupt' and published the failure;
            // this only stops an unhandled rejection.
            req.log.error(err, `Background build fetch failed for ${build.id as string}`);
          });
          return reply.status(202).send(build);
        }
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
