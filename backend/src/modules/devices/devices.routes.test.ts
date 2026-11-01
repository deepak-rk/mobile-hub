import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { devicesRoutes } from './devices.routes';

/**
 * Regression for an authorization gap found 2026-09-23: the three device-lock
 * routes were guarded by `app.authenticate` alone — authentication, no role —
 * while **every** other human-facing mutating route in the codebase (trigger,
 * cancel, install, uninstall, purge, refetch, stream-stop, recompute, config
 * reload, credentials) required a role. A read-only `viewer` could therefore
 * lock any device and renew that lock indefinitely, and a locked device
 * cannot start a queued execution run — so the least-privileged role could
 * deny every operator access to the whole lab.
 *
 * This asserts the guard each route *declares*, rather than driving real
 * JWTs: the bug was in the declaration, and verifying a signed token here
 * would be testing fastify-auth-kit instead of this file.
 */
async function routeGuards(): Promise<Map<string, string[]>> {
  const app = Fastify();
  const guards = new Map<string, string[]>();

  // Records which roles a route asked for, keyed by the preHandler identity
  // the route registers, then resolved back to the route in onRoute below.
  const roleOf = new Map<unknown, string[]>();
  const requireRole = (...roles: string[]) => {
    const fn = vi.fn();
    roleOf.set(fn, roles);
    return fn;
  };
  const authenticate = vi.fn();

  app.decorate('requireRole', requireRole);
  app.decorate('authenticate', authenticate);

  app.addHook('onRoute', (route) => {
    if (route.method === 'HEAD') return;
    const handlers = [route.preHandler ?? []].flat();
    const roles = handlers.flatMap((h) => roleOf.get(h) ?? (h === authenticate ? ['AUTH_ONLY'] : []));
    const method = Array.isArray(route.method) ? route.method.join('/') : route.method;
    guards.set(`${method} ${route.url}`, roles);
  });

  await app.register(devicesRoutes);
  await app.ready();
  await app.close();
  return guards;
}

describe('devices routes — authorization', () => {
  it('requires an operator or admin role to lock a device', async () => {
    const guards = await routeGuards();
    expect(guards.get('POST /:udid/lock')).toEqual(['operator', 'admin']);
  });

  it('requires an operator or admin role to renew a lock', async () => {
    const guards = await routeGuards();
    // Renew matters as much as lock: without it a viewer who had acquired a
    // lock could keep resetting its TTL and hold the device forever.
    expect(guards.get('POST /:udid/lock/renew')).toEqual(['operator', 'admin']);
  });

  it('requires an operator or admin role to unlock a device', async () => {
    const guards = await routeGuards();
    expect(guards.get('POST /:udid/unlock')).toEqual(['operator', 'admin']);
  });

  it('leaves no mutating device route on authentication alone', async () => {
    const guards = await routeGuards();
    // The shape of the original bug, stated directly: a route that mutates
    // state and asks only "are you signed in?" is the thing to catch.
    const authOnly = [...guards.entries()]
      .filter(([route, roles]) => route.startsWith('POST') && roles.includes('AUTH_ONLY'))
      .map(([route]) => route);
    expect(authOnly).toEqual([]);
  });
});
