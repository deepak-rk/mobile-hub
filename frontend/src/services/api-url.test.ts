import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSocketUrl } from 'use-resilient-websocket';

/**
 * The production image builds with an empty VITE_API_URL so every call stays
 * same-origin behind nginx's /api proxy. These pin what "empty" must produce:
 * relative REST calls and a WebSocket on the page's own host.
 */

async function loadApi() {
  vi.resetModules();
  return (await import('./api')).api;
}

/** The exact expression the stream hooks pass as `origin`. */
function socketOrigin(): string | undefined {
  return import.meta.env.VITE_API_URL || undefined;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('API URL building', () => {
  it('uses a relative /api base when VITE_API_URL is empty', async () => {
    vi.stubEnv('VITE_API_URL', '');
    expect((await loadApi()).defaults.baseURL).toBe('/api');
  });

  it('opens WebSockets on the page origin when VITE_API_URL is empty', () => {
    vi.stubEnv('VITE_API_URL', '');
    const url = buildSocketUrl('/api/devices/abc/stream', { origin: socketOrigin() });
    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    expect(url).toBe(`${scheme}//${window.location.host}/api/devices/abc/stream`);
  });

  it('keeps VITE_API_URL as an override for split-origin deployments', async () => {
    vi.stubEnv('VITE_API_URL', 'https://api.example.org');
    expect((await loadApi()).defaults.baseURL).toBe('https://api.example.org/api');
    expect(buildSocketUrl('/api/execution/r1/stream', { origin: socketOrigin() })).toBe(
      'wss://api.example.org/api/execution/r1/stream',
    );
  });
});
