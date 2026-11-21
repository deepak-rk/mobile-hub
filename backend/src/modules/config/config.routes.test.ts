import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { configRoutes } from './config.routes';
import { env } from '../../config/env';
import { PLATFORM_DEFAULTS, EffectiveConfig } from '../../config/org-config.schema';

// Same mock, and the same reason, as config.service.test.ts: `new
// Function`-wrapped import() survives tsc's CommonJS downlevel in the real
// build but throws under Vitest's vm sandbox. Delegating to a plain import()
// written here still loads the real layered-config-ts, so the reload path
// below runs the actual loader rather than a stub.
vi.mock('../../common/dynamic-import', () => ({
  default: (specifier: string) => import(specifier),
}));

/**
 * Real YAML files on disk, read through the real loader — the whole point of
 * the reload route is that an edit to a file reaches a running process, so
 * stubbing the load away would prove nothing.
 *
 * Auth is stubbed to a pass-through: `requireRole('admin')` is asserted by the
 * auth module's own tests, and reproducing a signed JWT here would test
 * fastify-auth-kit rather than this route.
 */
let tmpDir: string;
let app: FastifyInstance;
let origOrg: string;
let origProject: string;

/** `res.json()` is `any`; naming the shape here keeps the assertions typed. */
interface ReloadBody {
  reloaded: boolean;
  projects: { added: string[]; removed: string[]; total: number };
}
interface ErrorBody {
  code: string;
  message: string;
}

function writeOrgConfig(body: string): void {
  fs.writeFileSync(path.join(tmpDir, 'org.yaml'), body);
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-config-reload-test-'));
  origOrg = env.ORG_CONFIG_PATH;
  origProject = env.PROJECT_CONFIG_PATH;
  env.ORG_CONFIG_PATH = path.join(tmpDir, 'org.yaml');
  // Deliberately absent: a missing layer is a valid empty override, so this
  // also covers the "org file only" case an operator actually runs.
  env.PROJECT_CONFIG_PATH = path.join(tmpDir, 'project.yaml');

  app = Fastify();
  // Mirrors app.ts's getter/setter decorator rather than a plain value. That
  // is not test scaffolding: a plain value would be shadowed by the plugin's
  // encapsulated instance, so the reload would appear to succeed while every
  // other route kept reading the config from boot — which is exactly the bug
  // these tests caught.
  let current: EffectiveConfig = { ...PLATFORM_DEFAULTS, projects: {} };
  app.decorate('config', {
    getter: () => current,
    setter: (next: EffectiveConfig) => {
      current = next;
    },
  });
  app.decorate('requireRole', () => async () => {});
  await app.register(configRoutes);
});

afterEach(async () => {
  env.ORG_CONFIG_PATH = origOrg;
  env.PROJECT_CONFIG_PATH = origProject;
  await app.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('GET /features', () => {
  it('returns the four module toggles from the live config', async () => {
    const res = await app.inject({ method: 'GET', url: '/features' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ builds: true, execution: true, analytics: true, streaming: true });
  });

  it('reflects a toggle switched off by a reload, with no restart', async () => {
    writeOrgConfig('features:\n  analytics: false\n  streaming: false\n');
    await app.inject({ method: 'POST', url: '/reload' });

    const res = await app.inject({ method: 'GET', url: '/features' });

    expect(res.json()).toEqual({
      builds: true,
      execution: true,
      analytics: false,
      streaming: false,
    });
  });

  it('needs no role — reads are public, unlike GET / which is admin-only', async () => {
    // Swap the pass-through for a guard that always refuses: /features must
    // still answer, while the full config behind requireRole must not.
    const guarded = Fastify();
    guarded.decorate('config', { ...PLATFORM_DEFAULTS, projects: {} });
    guarded.decorate('requireRole', () => async () => {
      throw Object.assign(new Error('forbidden'), { statusCode: 403 });
    });
    await guarded.register(configRoutes);

    expect((await guarded.inject({ method: 'GET', url: '/features' })).statusCode).toBe(200);
    expect((await guarded.inject({ method: 'GET', url: '/' })).statusCode).toBe(403);
    await guarded.close();
  });

  it('returns only the toggles, never the rest of the config', async () => {
    writeOrgConfig('automation:\n  repoUrl: https://example.com/secret.git\n  framework: appium\n');
    await app.inject({ method: 'POST', url: '/reload' });

    const res = await app.inject({ method: 'GET', url: '/features' });

    expect(Object.keys(res.json<Record<string, unknown>>()).sort()).toEqual([
      'analytics',
      'builds',
      'execution',
      'streaming',
    ]);
  });
});

describe('POST /reload', () => {
  it('picks up a project declared after the process started', async () => {
    expect(app.config.projects).toEqual({});

    writeOrgConfig(`
projects:
  checkout:
    displayName: Checkout
    platform: android
`);

    const res = await app.inject({ method: 'POST', url: '/reload' });

    expect(res.statusCode).toBe(200);
    const body = res.json<ReloadBody>();
    expect(body.reloaded).toBe(true);
    expect(body.projects).toEqual({ added: ['checkout'], removed: [], total: 1 });
    // The decorated config the rest of the app reads is what actually changed
    // — the response body echoing it would mean nothing on its own.
    expect(app.config.projects.checkout?.displayName).toBe('Checkout');
  });

  it('reports a project removed from the file, not just added ones', async () => {
    writeOrgConfig('projects:\n  checkout: {}\n  demo: {}\n');
    await app.inject({ method: 'POST', url: '/reload' });
    expect(Object.keys(app.config.projects).sort()).toEqual(['checkout', 'demo']);

    writeOrgConfig('projects:\n  demo: {}\n');
    const res = await app.inject({ method: 'POST', url: '/reload' });

    expect(res.json<ReloadBody>().projects).toEqual({ added: [], removed: ['checkout'], total: 1 });
    expect(app.config.projects.checkout).toBeUndefined();
  });

  it('keeps the previous config when the new file is invalid', async () => {
    writeOrgConfig('projects:\n  checkout:\n    displayName: Checkout\n');
    await app.inject({ method: 'POST', url: '/reload' });
    const good = app.config;

    // A typo'd key, which is the realistic failure — an operator editing YAML
    // by hand. A reload that both rejects this *and* leaves the hub with no
    // usable config would turn a typo into an outage.
    writeOrgConfig('projects:\n  checkout:\n    platfrom: android\n');
    const res = await app.inject({ method: 'POST', url: '/reload' });

    expect(res.statusCode).toBe(400);
    expect(res.json<ErrorBody>().code).toBe('CONFIG_INVALID');
    // The message names the offending key — that is the whole value of the
    // response to whoever just made the edit.
    expect(res.json<ErrorBody>().message).toMatch(/platfrom/);
    expect(app.config).toBe(good);
  });

  it('reloads a changed automation repo, not only the project list', async () => {
    writeOrgConfig('automation:\n  repoUrl: https://example.com/old.git\n  framework: appium\n');
    await app.inject({ method: 'POST', url: '/reload' });
    expect(app.config.automation.repoUrl).toBe('https://example.com/old.git');

    writeOrgConfig('automation:\n  repoUrl: https://example.com/new.git\n  framework: appium\n');
    const res = await app.inject({ method: 'POST', url: '/reload' });

    expect(res.statusCode).toBe(200);
    // Unchanged project set, so nothing to report there — the point is that
    // the reload is not scoped to the projects block it summarises.
    expect(res.json<ReloadBody>().projects).toEqual({ added: [], removed: [], total: 0 });
    expect(app.config.automation.repoUrl).toBe('https://example.com/new.git');
  });
});
