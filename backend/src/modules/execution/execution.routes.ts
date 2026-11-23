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
  resyncExecutionRun,
  triggerExecutionRun,
} from './execution.service';
import type { IExecutionRun } from './execution-run.model';
import { subscribeToExecutionEvents } from './execution.events';
import { resolveInstallCommand, resolveRunCommand } from './automation-commands';
import { branchRefSchema, discoverSuites, SuiteDiscoveryError } from './suites/suites.service';
import { discoverBranches, BranchDiscoveryError } from './branches.service';
import { ExecutionRun } from './execution-run.model';
import { ALLURE_RESULTS_DIRNAME } from './allure-summary';
import { failedTestSelection, selectionArgs } from './rerun-selection';
import type { JwtPayload } from 'fastify-auth-kit';
import { ForbiddenError, NotFoundError, ValidationError } from '../../common/errors/app-error';
import { REPORT_CSP_DIRECTIVES } from '../../common/content-security-policy';

const commandSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
});

// Every filter optional; an empty string means "not filtering" (the frontend
// can send a cleared field), same as the unvalidated reads this replaced.
const listQuery = z.object({
  project: z.string().optional(),
  status: z.string().optional(),
  deviceUdid: z.string().optional(),
  // Host-scopes `deviceUdid` — see `listExecutionRuns`.
  machineId: z.string().optional(),
  suite: z.string().optional(),
});

const triggerBody = z.object({
  machineId: z.string().min(1),
  deviceUdid: z.string().min(1),
  buildId: z.string().optional(),
  project: z.string().min(1),
  // Embedded in a git refspec when the run checks out, so held to the same
  // rule as suite discovery's ?branch=.
  branch: branchRefSchema,
  variant: z.string().min(1).max(64).optional(),
  suite: z.string().min(1),
  // Both optional now: a configured project already declares how it installs
  // and runs, so making the operator retype it was the config not being used.
  // Supplying them still wins, for a one-off that differs from the config.
  setup: commandSchema.optional(),
  run: commandSchema.optional(),
});

const suitesQuery = z.object({
  refresh: z.unknown().optional(),
  branch: branchRefSchema.optional(),
});

const rerunBody = z.object({ failedOnly: z.boolean().optional() });

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
    const query = listQuery.safeParse(req.query);
    if (!query.success) {
      throw new ValidationError(query.error.message);
    }
    const runs = await listExecutionRuns(query.data);
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
    // platforms/variants are what the trigger form needs to offer the right
    // devices and a variant picker; empty for a name seen only in history.
    const byId = new Map(
      declared.map((p) => [
        p.id,
        {
          id: p.id,
          displayName: p.displayName,
          declared: true,
          platforms: p.platforms,
          variants: p.variants,
        },
      ]),
    );
    for (const name of historical) {
      if (typeof name === 'string' && name && !byId.has(name)) {
        byId.set(name, {
          id: name,
          displayName: name,
          declared: false,
          platforms: [],
          variants: [],
        });
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
   * `?branch=` reads suites from that branch (the one the run will execute);
   * omitted, the repo's default branch is used.
   */
  app.get('/projects/:projectId/suites', async (req) => {
    const { projectId } = req.params as { projectId: string };
    const query = suitesQuery.safeParse(req.query);
    if (!query.success) {
      throw new ValidationError(query.error.issues.map((i) => i.message).join(' '));
    }
    const { refresh, branch } = query.data;
    const project = app.config.projects[projectId];
    if (!project) {
      throw new NotFoundError(
        `No project '${projectId}' is declared in config.`,
        'PROJECT_NOT_CONFIGURED',
      );
    }

    try {
      const suites = await discoverSuites(projectId, project.automation, {
        refresh: Boolean(refresh),
        branch,
      });
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
      throw new NotFoundError(
        `No project '${projectId}' is declared in config.`,
        'PROJECT_NOT_CONFIGURED',
      );
    }
    if (!project.automation.repoUrl) {
      return { branches: [], unavailable: 'This project has no automation.repoUrl configured.' };
    }

    try {
      return await discoverBranches(project.automation.repoUrl, { refresh: Boolean(refresh) });
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
      const project = app.config.projects[body.data.project];
      const automation = project?.automation ?? app.config.automation;
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
        project,
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
      const { failedOnly } = rerunBody.parse(req.body ?? {});
      const original = await getExecutionRun(id);
      if (!original) throw new NotFoundError('Execution run not found');

      const project = app.config.projects[original.project];
      const automation = project?.automation ?? app.config.automation;
      const setup = resolveInstallCommand(automation) ?? undefined;
      // Failed-only: the original's failed tests, selected by feature file
      // and scenario name. Refused (409) rather than widened to the whole
      // suite when they cannot all be pinned down.
      const selection = failedOnly ? failedTestSelection(original.testSummary?.testCases) : null;
      const runCommand = resolveRunCommand(
        automation,
        original.suite,
        selection ? selectionArgs(automation, selection) : undefined,
      );

      const run = await triggerExecutionRun(
        {
          machineId: original.machineId,
          deviceUdid: original.deviceUdid,
          buildId: original.buildId?.toString(),
          project: original.project,
          branch: original.branch,
          variant: original.variant ?? undefined,
          suite: original.suite,
          setup,
          run: runCommand,
          triggeredBy: req.user.sub,
          rerun: {
            of: String(original._id),
            scope: selection ? 'failed' : 'all',
            tests: selection?.testIds ?? [],
          },
        },
        automation,
        app.config.appium,
        project,
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
    return prepared
      .header('Content-Type', 'text/plain; charset=utf-8')
      .send(fs.createReadStream(run.logPath));
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

  // Report HTML is untrusted runner output, so it gets the sandboxed policy
  // instead of the API one (see common/content-security-policy.ts). The
  // sandbox gives the page an opaque origin, which makes every load of the
  // report's own files (a multi-file report's app.js, screenshots) a
  // cross-origin request — helmet's default `Cross-Origin-Resource-Policy:
  // same-origin` would block them, so this route relaxes it. The route is
  // already unauthenticated, so that exposes nothing new.
  const reportHelmet = {
    contentSecurityPolicy: { useDefaults: false, directives: REPORT_CSP_DIRECTIVES },
    crossOriginResourcePolicy: { policy: 'cross-origin' as const },
  };

  app.get('/:id/report/*', { helmet: reportHelmet }, async (req, reply) => {
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

    // The sandboxed report page has the opaque origin "null", so a report
    // that loads its own data with fetch()/XHR (Allure 2's multi-file layout
    // reads data/*.json that way) is making a CORS request. Production runs
    // with CORS off, so without this the report rendered empty there while
    // working in dev, where CORS reflects any origin. Only "null" is allowed
    // and never with credentials: the route is already unauthenticated, so
    // this reveals nothing a plain GET could not.
    return reply
      .header('access-control-allow-origin', 'null')
      .sendFile(relativePath, run.reportPath);
  });

  /**
   * The failing-step screenshot of one failed test (see `failureEvidenceOf`).
   * Serves only a file the run's own summary names as evidence, from the
   * run's kept Allure results: the name is a lookup key, never a path.
   */
  app.get('/:id/evidence/:file', async (req, reply) => {
    const { id, file } = req.params as { id: string; file: string };
    const run = await getExecutionRun(id);
    const named = run?.testSummary?.testCases?.some((t) => t.evidence === file) ?? false;
    if (!run?.artifactsPath || !named) {
      throw new NotFoundError('No such evidence for this run.', 'EVIDENCE_UNAVAILABLE');
    }
    return reply.sendFile(file, path.join(run.artifactsPath, ALLURE_RESULTS_DIRNAME));
  });

  /**
   * Rebuilds a finished run's test summary from its kept raw results. Repair
   * only: never changes the run's status.
   */
  app.post('/:id/resync', { preHandler: app.requireRole('operator', 'admin') }, async (req) => {
    const { id } = req.params as { id: string };
    return resyncExecutionRun(id);
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
