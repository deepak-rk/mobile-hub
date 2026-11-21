import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Types } from 'mongoose';
import { buildApp } from '../app';
import { PLATFORM_DEFAULTS } from '../config/org-config.schema';
import { ExecutionRun } from '../modules/execution/execution-run.model';

// Same reason as config.routes.test.ts: the `new Function`-wrapped import()
// throws under Vitest's vm sandbox; a plain import() still loads the real
// fastify-auth-kit.
vi.mock('./dynamic-import', () => ({
  default: (specifier: string) => import(specifier),
}));

/**
 * Asserts the CSP header through the real buildApp(), not a copy of its
 * wiring — the per-route overrides only work if the plugins are registered
 * in the right order and scope, which is exactly what a hand-built test app
 * would not prove.
 */
let app: FastifyInstance;
let reportDir: string;

beforeAll(async () => {
  reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-csp-report-'));
  fs.writeFileSync(path.join(reportDir, 'index.html'), '<!doctype html><script>document.title="r"</script>');
  vi.spyOn(ExecutionRun, 'findById').mockResolvedValue({ reportPath: reportDir } as never);
  app = await buildApp(PLATFORM_DEFAULTS);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  fs.rmSync(reportDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('Content-Security-Policy', () => {
  it('sends the strict API policy on API routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-security-policy']).toBe(
      "default-src 'none';base-uri 'none';form-action 'none';frame-ancestors 'none'",
    );
  });

  it('sends the docs policy on the Swagger UI, allowing its own scripts', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs/' });
    expect(res.statusCode).toBe(200);
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toContain('sandbox');

    const asset = await app.inject({ method: 'GET', url: '/docs/static/swagger-ui-bundle.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['content-security-policy']).toBe(csp);
  });

  it('serves Allure reports sandboxed without same-origin, but able to run inline scripts', async () => {
    const id = new Types.ObjectId().toString();
    const res = await app.inject({ method: 'GET', url: `/api/execution/${id}/report/index.html` });
    expect(res.statusCode).toBe(200);
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toMatch(/(^|;)sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox(;|$)/);
    expect(csp).not.toContain('allow-same-origin');
    expect(csp).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:");
    expect(csp).toContain("style-src 'self' 'unsafe-inline' data:");
    expect(csp).toContain("img-src 'self' data: blob:");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
  });

  it('keeps the strict policy on the report redirect, which renders nothing', async () => {
    const id = new Types.ObjectId().toString();
    const res = await app.inject({ method: 'GET', url: `/api/execution/${id}/report` });
    expect(res.statusCode).toBe(302);
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['content-security-policy']).not.toContain('sandbox');
  });
});
