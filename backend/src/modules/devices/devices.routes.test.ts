import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { devicesRoutes } from './devices.routes';
import { Device } from './device.model';
import { InstallRun } from '../device-installs/install-run.model';

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

/**
 * Regression: `activeInstall` was keyed by UDID alone, so an install on host
 * A's `emulator-5554` showed "Installing" on every host's `emulator-5554`.
 * And `GET /:udid` omitted the field entirely while the list included it.
 */
interface DeviceView {
  machineId: string;
  activeInstall: boolean;
}

describe('devices routes — activeInstall is host-scoped', () => {
  const device = (machineId: string) => ({
    udid: 'emulator-5554',
    machineId,
    toObject() {
      return { udid: 'emulator-5554', machineId };
    },
  });

  async function appWithInstallOnHostA() {
    vi.spyOn(InstallRun, 'find').mockResolvedValue([
      { targets: [{ deviceUdid: 'emulator-5554', machineId: 'host-a', status: 'installing' }] },
    ] as never);
    vi.spyOn(Device, 'find').mockReturnValue({
      sort: () => Promise.resolve([device('host-a'), device('host-b')]),
    } as never);
    vi.spyOn(Device, 'findOne').mockImplementation(
      ((filter: { machineId?: string }) => Promise.resolve(device(filter.machineId ?? 'host-a'))) as never,
    );
    const app = Fastify();
    app.decorate('requireRole', () => vi.fn());
    app.decorate('authenticate', vi.fn());
    await app.register(devicesRoutes);
    return app;
  }

  it('marks only the host that is actually installing, in the list', async () => {
    const app = await appWithInstallOnHostA();
    const res = await app.inject({ method: 'GET', url: '/' });
    const flags = res.json<DeviceView[]>().map((d) => [d.machineId, d.activeInstall]);
    expect(flags).toEqual([
      ['host-a', true],
      ['host-b', false],
    ]);
    await app.close();
  });

  it('includes the same host-scoped activeInstall on the single-device route', async () => {
    const app = await appWithInstallOnHostA();
    const a = await app.inject({ method: 'GET', url: '/emulator-5554?machineId=host-a' });
    const b = await app.inject({ method: 'GET', url: '/emulator-5554?machineId=host-b' });
    expect(a.json<DeviceView>().activeInstall).toBe(true);
    expect(b.json<DeviceView>().activeInstall).toBe(false);
    await app.close();
  });
});
