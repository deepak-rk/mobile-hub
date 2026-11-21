import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { AppError } from './errors/app-error';
import type { EffectiveConfig } from '../config/org-config.schema';

export type Feature = keyof EffectiveConfig['features'];

/** A request to a module the organisation has switched off. */
export class FeatureDisabledError extends AppError {
  constructor(feature: Feature) {
    super(`The ${feature} feature is disabled for this organisation`, 404, 'FEATURE_DISABLED');
  }
}

/**
 * Wraps a module's routes so they answer `FEATURE_DISABLED` while
 * `features.<feature>` is false.
 *
 * The toggles were parsed and validated from org config but never read, so
 * switching a module off changed nothing. The check runs per request against
 * `app.config`, which is reloadable, so a toggle takes effect without a
 * restart. Its timers are gated separately in server.ts: hiding the routes but
 * leaving a timer firing is the trap a production farm in this domain hit
 * (a client-side flag left the scheduler running).
 */
export function gated(app: FastifyInstance, feature: Feature, routes: FastifyPluginAsync): FastifyPluginAsync {
  return async (scope) => {
    scope.addHook('onRequest', async () => {
      if (!app.config.features[feature]) throw new FeatureDisabledError(feature);
    });
    await scope.register(routes);
  };
}
