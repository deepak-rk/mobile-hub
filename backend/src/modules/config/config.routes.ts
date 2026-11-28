import { FastifyPluginAsync } from 'fastify';
import { loadEffectiveConfig } from '../../config/config.service';
import { env } from '../../config/env';

export const configRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', { preHandler: app.requireRole('admin') }, () => {
    return app.config;
  });

  /**
   * The module toggles alone, for the frontend to hide what is switched off.
   *
   * Public on purpose (project decision: reads are public, only actions are
   * gated) and not itself wrapped in gated() — it is how a client learns what
   * is gated. Only the four booleans are returned: the full config above stays
   * admin-only because it carries repo URLs and provider endpoints.
   */
  app.get('/features', () => {
    const { builds, execution, analytics, streaming } = app.config.features;
    return { builds, execution, analytics, streaming };
  });

  /**
   * Re-reads `mobilehub.org.yaml` + `mobilehub.project.yaml` from disk.
   *
   * Config was boot-only, so declaring a project or pointing one at a
   * different automation repo meant restarting the backend — which drops every
   * live log stream and device capture along with it. That is a heavy price
   * for an edit to a YAML file, and it was hit repeatedly during verification.
   *
   * Loaded into a local first and swapped in only on success: a typo'd key
   * must leave the running config exactly as it was. A reload that both fails
   * validation *and* leaves the hub with no usable config would turn a typo
   * into an outage.
   *
   * Every consumer reads `app.config` per request, so the swap is all that is
   * needed — with one caveat worth stating: anything that closed over the
   * config object at boot would keep the old values. The two periodic sweeps
   * in `server.ts` were doing exactly that and now read `app.config` at tick
   * time.
   */
  app.post('/reload', { preHandler: app.requireRole('admin') }, async (_request, reply) => {
    let next;
    try {
      next = await loadEffectiveConfig(env.ORG_CONFIG_PATH, env.PROJECT_CONFIG_PATH, {
        hubAppiumHost: env.HUB_APPIUM_HOST,
        warn: (message) => app.log.warn(`Config: ${message}`),
      });
    } catch (err) {
      // Returned to the operator rather than only logged: the message names
      // the offending key, which is the entire value of the request. Same
      // `{ code, message }` shape the other routes use.
      return reply.status(400).send({
        code: 'CONFIG_INVALID',
        message: `Config reload failed, keeping the previous config: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    const before = Object.keys(app.config.projects);
    const after = Object.keys(next.projects);
    app.config = next;

    app.log.info({ projects: after.length }, 'Config reloaded from disk');

    // Project changes are called out because declaring one is the common
    // reason to reload, and "it reloaded" alone does not tell the operator
    // whether their edit landed in the block they meant.
    return {
      reloaded: true,
      projects: {
        added: after.filter((id) => !before.includes(id)),
        removed: before.filter((id) => !after.includes(id)),
        total: after.length,
      },
      config: next,
    };
  });
};
