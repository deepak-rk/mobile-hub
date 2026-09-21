import * as fs from 'fs';
import * as path from 'path';
import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import type { WebSocket } from 'ws';
import { env } from '../../config/env';
import {
  cancelExecutionRun,
  getExecutionRun,
  getQueuePosition,
  listExecutionRuns,
  triggerExecutionRun,
} from './execution.service';
import type { IExecutionRun } from './execution-run.model';
import { subscribeToExecutionEvents } from './execution.events';
import { resolveInstallCommand, resolveRunCommand } from './automation-commands';
import { discoverSuites, SuiteDiscoveryError } from './suites/suites.service';
import { discoverBranches, BranchDiscoveryError } from './branches.service';
import { ExecutionRun } from './execution-run.model';
import type { JwtPayload } from 'fastify-auth-kit';
import { ForbiddenError, NotFoundError, ValidationError } from '../../common/errors/app-error';

const commandSchema = z.object({ command: z.string().min(1), args: z.array(z.string()).default([]) });

const triggerBody = z.object({
  machineId: z.string().min(1),
  deviceUdid: z.string().min(1),
  buildId: z.string().optional(),
  project: z.string().min(1),
  branch: z.string().min(1),
  suite: z.string().min(1),
  // Both optional now: a configured project already declares how it installs
  // and runs, so making the operator retype it was the config not being used.
  // Supplying them still wins, for a one-off that differs from the config.
  setup: commandSchema.optional(),
  run: commandSchema.optional(),
});

export const executionRoutes: FastifyPluginAsync = async (app) => {
  // `serve: false` — this registers nothing of its own; it exists only to
  // decorate `reply.sendFile`, which accepts a per-call root. An Allure report
  // lives under a different directory for every run, so a plugin with one
  // fixed root could not serve them. Registered inside this plugin's scope so
  // the decorator stays local and cannot collide with another module's.
  await app.register(fastifyStatic, { root: env.EXECUTION_ARTIFACTS_DIR, serve: false });

  // Attaches `queuePosition` (null unless the run is genuinely queued) — a
  // per-device rank computed at read time, not stored on the run itself,
  // since it's only ever meaningful relative to whatever else is queued
  // right now. Same "derive at request time" shape devices.routes.ts already
  // uses for `activeInstall`.
  const withQueuePosition = async (run: IExecutionRun) => ({
    ...(run.toObject() as Record<string, unknown>),
    queuePosition: await getQueuePosition(run),
  });

  app.get('/', async (req) => {
    const { project, status, deviceUdid, suite } = req.query as Record<string, string>;
    const runs = await listExecutionRuns({ project, status, deviceUdid, suite });
    return Promise.all(runs.map(withQueuePosition));
  });

  /**
   * Selectable project names for the trigger form.
   *
   * Sourced from org/project YAML config, which is the declared truth. Projects
   * seen only in run history are folded in behind `declared: false` so a run
   * triggered before its project was declared doesn't vanish from the picker —
   * and so the caller can say that such a project inherits org defaults rather
   * than carrying its own automation config.
   *
   * Declared before `/:id` so `projects` is never parsed as a run id.
   */
  app.get('/projects', async () => {
    // Declared projects are the real answer; past runs are folded in so a
    // project that predates being declared (or was triggered ad hoc) doesn't
    // vanish from the picker. `distinct` is typed unknown[], so values are
    // narrowed rather than asserted.
    const declared = Object.values(app.config.projects);
    const historical = await ExecutionRun.distinct('project');
    const byId = new Map(declared.map((p) => [p.id, { id: p.id, displayName: p.displayName, declared: true }]));
    for (const name of historical) {
      if (typeof name === 'string' && name && !byId.has(name)) {
        byId.set(name, { id: name, displayName: name, declared: false });
      }
    }
    const projects = [...byId.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
    return { projects };
  });

  /**
   * Runnable suites for a project, read from its automation repo.
   *
   * Also declared before `/:id`, for the same reason `projects` is.
   * `?refresh=1` bypasses the cache, for when someone just pushed a suite.
   */
  app.get('/projects/:projectId/suites', async (req) => {
    const { projectId } = req.params as { projectId: string };
    const { refresh } = req.query as { refresh?: string };
    const project = app.config.projects[projectId];
    if (!project) {
      throw new NotFoundError(`No project '${projectId}' is declared in config.`, 'PROJECT_NOT_CONFIGURED');
    }

    try {
      const suites = await discoverSuites(projectId, project.automation, { refresh: Boolean(refresh) });
      return { suites };
    } catch (err) {
      if (err instanceof SuiteDiscoveryError) {
        // 200 with an explanation, not an error status: "we can't list suites
        // for this project" is a normal state the form handles by falling back
        // to a text field, not a failure of the request.
        return { suites: [], unavailable: err.message };
      }
      throw err;
    }
  });

  /**
   * Real branch names for a project, straight from its git remote.
   *
   * Also declared before `/:id`, for the same reason `projects`/`suites` are.
   * Same 200-with-explanation shape as suites: "can't list branches" is a
   * normal state the form handles by falling back to free text, not a
   * failure of the request.
   */
  app.get('/projects/:projectId/branches', async (req) => {
    const { projectId } = req.params as { projectId: string };
    const { refresh } = req.query as { refresh?: string };
    const project = app.config.projects[projectId];
    if (!project) {
      throw new NotFoundError(`No project '${projectId}' is declared in config.`, 'PROJECT_NOT_CONFIGURED');
    }
    if (!project.automation.repoUrl) {
      return { branches: [], unavailable: 'This project has no automation.repoUrl configured.' };
    }

    try {
      const branches = await discoverBranches(project.automation.repoUrl, { refresh: Boolean(refresh) });
      return { branches };
    } catch (err) {
      if (err instanceof BranchDiscoveryError) {
        return { branches: [], unavailable: err.message };
      }
      throw err;
    }
  });

  app.get('/:id', async (req) => {
    const { id } = req.params as { id: string };
    const run = await getExecutionRun(id);
    if (!run) throw new NotFoundError('Execution run not found');
    return withQueuePosition(run);
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
      // A declared project's own automation block wins over the org default —
      // that per-project override is the entire point of declaring one.
      const automation = app.config.projects[body.data.project]?.automation ?? app.config.automation;
      // Config decides how to install and run unless this trigger overrode it.
      // A busy device no longer 409s here — triggerExecutionRun queues the run
      // instead (dispatchQueuedRuns starts it once the device frees up).
      // UnsupportedFrameworkError (400, code NO_RUN_COMMAND — nothing
      // configured and nothing supplied) is still a typed AppError; the
      // global error handler in app.ts maps it, so nothing here catches it.
      const setup = body.data.setup ?? resolveInstallCommand(automation) ?? undefined;
      const runCommand = body.data.run ?? resolveRunCommand(automation, body.data.suite);

      const run = await triggerExecutionRun(
        { ...body.data, setup, run: runCommand, triggeredBy: req.user.sub },
        automation,
        app.config.appium,
      );
      return reply.status(201).send(run);
    },
  );

  /**
   * Re-runs an existing run's immutable inputs (machineId, deviceUdid,
   * buildId, project, branch, suite) as a brand-new trigger.
   *
   * Deliberately re-resolves `automation` and the setup/run commands from
   * the *current* config rather than replaying whatever the original run
   * happened to use — "re-resolve device/branch/secrets" is the whole point
   * (`docs/SOURCE_FEATURE_TRACEABILITY.md`). A run doesn't store which
   * setup/run commands it actually used as *inputs* (only what ended up in
   * its stages), so there is nothing frozen to replay even if that were
   * wanted — re-running always means "run this again under today's config",
   * never "run this exact stale configuration again."
   */
  app.post(
    '/:id/rerun',
    {
      preHandler: app.requireRole('operator', 'admin'),
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const original = await getExecutionRun(id);
      if (!original) throw new NotFoundError('Execution run not found');

      const automation = app.config.projects[original.project]?.automation ?? app.config.automation;
      const setup = resolveInstallCommand(automation) ?? undefined;
      const runCommand = resolveRunCommand(automation, original.suite);

      const run = await triggerExecutionRun(
        {
          machineId: original.machineId,
          deviceUdid: original.deviceUdid,
          buildId: original.buildId?.toString(),
          project: original.project,
          branch: original.branch,
          suite: original.suite,
          setup,
          run: runCommand,
          triggeredBy: req.user.sub,
        },
        automation,
        app.config.appium,
      );
      return reply.status(201).send(run);
    },
  );

  /**
   * The run's log as stored on disk.
   *
   * The WebSocket below only carries lines emitted while a client is watching,
   * so reopening a finished run showed an empty "Waiting for output…" panel
   * forever even though the whole log was sitting on disk. This serves that
   * file, which is why it now lives under `artifactsPath` rather than inside
   * the workspace that gets deleted when a run ends.
   */
  app.get('/:id/logs', async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = await getExecutionRun(id);
    if (!run) throw new NotFoundError('Execution run not found');

    // Runs from before durable artifacts existed kept their log inside the
    // workspace; say so plainly rather than 404ing as if the run never had one.
    if (!run.logPath || !fs.existsSync(run.logPath)) {
      throw new NotFoundError('No log file is stored for this run.', 'LOG_UNAVAILABLE');
    }
    // `?download=1` serves the same bytes as an attachment. Done server-side
    // with Content-Disposition rather than client-side from the fetched text:
    // a run log is unbounded, and building a Blob from it would hold the whole
    // file in the tab's memory just to save it. Streaming costs nothing.
    const { download } = req.query as { download?: string };
    // Chained rather than called for its side effect: `reply.header()` returns
    // the reply, which lint reads as a floating promise when discarded.
    const prepared = download
      ? reply.header('Content-Disposition', `attachment; filename="run-${id}.log"`)
      : reply;
    return prepared.header('Content-Type', 'text/plain; charset=utf-8').send(fs.createReadStream(run.logPath));
  });

  /**
   * The Allure report, when the runner produced one.
   *
   * `reportPath` is only ever set by `collectAllureReport`, which requires a
   * real `index.html` — so a 404 here means the run genuinely has no report,
   * not that serving it failed. The frontend hides the link entirely in that
   * case rather than offering one that dead-ends.
   */
  app.get('/:id/report', async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = await getExecutionRun(id);
    if (!run?.reportPath) {
      throw new NotFoundError('No report is stored for this run.', 'REPORT_UNAVAILABLE');
    }
    // Redirect off the caller's own URL rather than a hardcoded prefix — the
    // `/api/execution` mount point is chosen in app.ts, not here.
    const base = req.url.split('?')[0].replace(/\/+$/, '');
    return reply.redirect(`${base}/index.html`);
  });

  app.get('/:id/report/*', async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = await getExecutionRun(id);
    if (!run?.reportPath) {
      throw new NotFoundError('No report is stored for this run.', 'REPORT_UNAVAILABLE');
    }

    const relativePath = (req.params as Record<string, string>)['*'] || 'index.html';
    // An Allure report is a tree of files the hub never inspects, and the
    // wildcard is attacker-controlled. `send` (inside @fastify/static) rejects
    // escaping paths itself, but a traversal guard is cheap and this asserts
    // the property directly instead of trusting a transitive dependency's
    // behaviour to stay unchanged.
    const resolved = path.resolve(run.reportPath, relativePath);
    const root = path.resolve(run.reportPath);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new ForbiddenError('Path escapes the report directory.');
    }

    return reply.sendFile(relativePath, run.reportPath);
  });

  app.post('/:id/cancel', { preHandler: app.requireRole('operator', 'admin') }, async (req) => {
    const { id } = req.params as { id: string };
    // RunNotCancellableError is a typed ConflictError now; the global error
    // handler maps it, so no local catch is needed.
    const run = await cancelExecutionRun(id);
    if (!run) throw new NotFoundError('Execution run not found');
    return { message: 'Cancellation requested', run };
  });

  // Auth via ?token= since a plain WS upgrade can't easily carry an
  // Authorization header from a browser client. Verified synchronously
  // before subscribing to anything - an invalid/missing token gets no events.
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

    const unsubscribe = subscribeToExecutionEvents(id, (event) => {
      socket.send(JSON.stringify(event));
    });
    socket.on('close', unsubscribe);
  });
};
