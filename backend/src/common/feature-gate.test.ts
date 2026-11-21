import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { gated } from './feature-gate';
import { AppError } from './errors/app-error';

/**
 * Regression (2026-11-21): org config's features.* toggles were validated
 * but never read, so switching a module off changed nothing.
 */
function appWith(features: Record<string, boolean>) {
  const app = Fastify();
  app.decorate('config', { features } as never);
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ code: err.code });
    return reply.status(500).send();
  });
  void app.register(
    gated(app, 'execution', async (r) => {
      r.get('/runs', async () => ({ ok: true }));
    }),
    { prefix: '/api/execution' },
  );
  void app.register(async (r) => {
    r.get('/api/devices', async () => ({ ok: true }));
  });
  return app;
}

describe('gated()', () => {
  it('serves a module while its feature is on', async () => {
    const res = await appWith({ execution: true }).inject('/api/execution/runs');
    expect(res.statusCode).toBe(200);
  });

  it('answers FEATURE_DISABLED while it is off, and leaves other routes alone', async () => {
    const app = appWith({ execution: false });
    const res = await app.inject('/api/execution/runs');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ code: 'FEATURE_DISABLED' });
    expect((await app.inject('/api/devices')).statusCode).toBe(200);
  });

  it('follows a config reload without re-registering', async () => {
    const features = { execution: true };
    const app = appWith(features);
    expect((await app.inject('/api/execution/runs')).statusCode).toBe(200);
    features.execution = false;
    expect((await app.inject('/api/execution/runs')).statusCode).toBe(404);
  });
});
