import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  assertDriverInstalled,
  closeActiveSessions,
  ensureRemoteAppiumServer,
  getPendingAppiumRequestsForMachine,
  reportRemoteAppiumReady,
} from './appium.service';
import { Device } from '../devices/device.model';
import type { IDevice } from '../devices/device.model';
import type { EffectiveConfig } from '../../config/org-config.schema';

/**
 * `closeActiveSessions` — the other half of a cancelled/orphaned run's
 * cleanup. Appium servers here are one-per-device and long-lived (reused
 * across many runs), so killing a run's process tree never closes a
 * WebDriver session that run may have opened inside one; left alone, the
 * next run's session-creation fails against a server that looks healthy.
 * Only this function is unit-testable without a real Appium binary — server
 * start/adopt logic needs one and is covered by live verification instead.
 */
afterEach(() => {
  vi.restoreAllMocks();
});

const config = { appium: { enabled: true, host: '127.0.0.1', basePort: 4723 } } as EffectiveConfig;

function fakeDevice(appiumPort: number | null): IDevice {
  return { udid: 'd1', machineId: 'host-1', appiumPort } as unknown as IDevice;
}

describe('closeActiveSessions — remote-managed devices', () => {
  const remoteConfig = {
    appium: { enabled: true, host: '127.0.0.1', basePort: 4723, remoteEnabled: true },
  } as EffectiveConfig;

  function remoteDevice(): IDevice {
    // The real shape on the remote path: appiumPort is NEVER assigned (that's
    // the hub-local spawn's field), the agent-reported endpoint is the only
    // place the real server lives.
    return {
      udid: 'd1',
      machineId: 'host-1',
      appiumPort: null,
      remoteAppium: { host: '10.0.0.7', port: 4750, readyAt: new Date() },
    } as unknown as IDevice;
  }

  /**
   * Regression, found live 2026-09-22: this function built its endpoint from
   * `config.appium.host` + `device.appiumPort` unconditionally — the
   * *hub-local* pair. On the remote path `appiumPort` is null, so cleanup
   * returned immediately and silently did nothing, leaking the exact
   * orphaned WebDriver session this function exists to close.
   */
  it('targets the agent-reported endpoint, not the hub-local host/port', async () => {
    const fetchSpy = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
      if (url.endsWith('/status')) return Promise.resolve({ ok: true });
      if (url.endsWith('/sessions')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ value: [{ id: 'remote-sess' }] }) });
      }
      if (opts?.method === 'DELETE') return Promise.resolve({ ok: true });
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchSpy);

    await closeActiveSessions(remoteDevice(), remoteConfig);

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('http://10.0.0.7:4750'),
      expect.anything() as RequestInit,
    );
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/session/remote-sess'),
      expect.objectContaining({ method: 'DELETE' }),
    );
    // Never touches the hub-local pair, which owns no server on this path.
    expect(fetchSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('127.0.0.1:4723'),
      expect.anything() as RequestInit,
    );
  });

  it('falls back to the hub-local endpoint when remoteEnabled is off, even if a stale remoteAppium lingers', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: false });
    vi.stubGlobal('fetch', fetchSpy);

    await closeActiveSessions(
      { ...remoteDevice(), appiumPort: 4723 } as unknown as IDevice,
      config, // remoteEnabled absent/false
    );

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('127.0.0.1:4723'),
      expect.anything() as RequestInit,
    );
  });
});

describe('closeActiveSessions', () => {
  it('does nothing when the device has never been assigned an Appium port', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await closeActiveSessions(fakeDevice(null), config);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does nothing when no server answers on the device\'s assigned port', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchSpy);

    await closeActiveSessions(fakeDevice(4723), config);

    // Both base-path /status probes ('' then '/wd/hub') — neither answered,
    // so it never got far enough to ask for sessions.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('adopts a foreign server still running under the legacy /wd/hub base path, and closes sessions at the same prefix', async () => {
    // An org's own Appium fleet, not spawned by this hub, may still default to
    // the pre-Appium-2 /wd/hub convention — the bare-path probe must not be
    // the only one tried, and the DELETE must land at the same prefix the
    // GET succeeded at, not the bare path.
    const fetchSpy = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
      // Checked in this order because '/status'.endsWith also matches
      // '/wd/hub/status' — the more specific legacy path must be tested first.
      if (url.endsWith('/wd/hub/status')) return Promise.resolve({ ok: true });
      if (url.endsWith('/status')) return Promise.resolve({ ok: false }); // bare path: not this server
      if (url.endsWith('/appium/sessions')) return Promise.resolve({ ok: false, status: 404 }); // pre-Appium-2 server
      if (url.endsWith('/wd/hub/sessions')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ value: [{ id: 'legacy-sess' }] }) });
      }
      if (opts?.method === 'DELETE') return Promise.resolve({ ok: true });
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchSpy);

    await closeActiveSessions(fakeDevice(4723), config);

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/wd/hub/session/legacy-sess'),
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('deletes every active session reported by a running server (W3C {value: [...]} shape)', async () => {
    const fetchSpy = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
      if (url.endsWith('/status')) return Promise.resolve({ ok: true });
      if (url.endsWith('/sessions')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ value: [{ id: 'sess-1' }, { id: 'sess-2' }] }) });
      }
      if (opts?.method === 'DELETE') return Promise.resolve({ ok: true });
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchSpy);

    await closeActiveSessions(fakeDevice(4723), config);

    expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining('/session/sess-1'), expect.objectContaining({ method: 'DELETE' }));
    expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining('/session/sess-2'), expect.objectContaining({ method: 'DELETE' }));
  });

  it('is best-effort: a session that fails to delete does not throw and does not block the others', async () => {
    const fetchSpy = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
      if (url.endsWith('/status')) return Promise.resolve({ ok: true });
      if (url.endsWith('/sessions')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ value: [{ id: 'sess-1' }, { id: 'sess-2' }] }) });
      }
      if (opts?.method === 'DELETE' && url.includes('sess-1')) return Promise.reject(new Error('boom'));
      if (opts?.method === 'DELETE') return Promise.resolve({ ok: true });
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchSpy);

    await expect(closeActiveSessions(fakeDevice(4723), config)).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining('/session/sess-2'), expect.objectContaining({ method: 'DELETE' }));
  });
});

/**
 * The remote-locality relay: a device attached to another machine cannot be
 * given an Appium endpoint by spawning locally (`docs/reference-review-2026-09-14/01-architecture-findings.md`
 * §1.3) — the hub instead records a request and waits for the owning agent
 * to report one back, discovered on that agent's own next heartbeat.
 */
describe('ensureRemoteAppiumServer', () => {
  function fakeRemoteDevice(overrides: Partial<IDevice> = {}): IDevice {
    return {
      _id: 'device-1',
      udid: 'd1',
      machineId: 'host-2',
      remoteAppium: null,
      ...overrides,
    } as unknown as IDevice;
  }

  it('adopts an already-reported endpoint that is still healthy, without re-requesting', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true }); // /status
    vi.stubGlobal('fetch', fetchSpy);
    const updateSpy = vi.spyOn(Device, 'findOneAndUpdate');
    const findByIdSpy = vi.spyOn(Device, 'findByIdAndUpdate');

    const device = fakeRemoteDevice({ remoteAppium: { host: '10.0.0.5', port: 4823, readyAt: new Date() } });
    const endpoint = await ensureRemoteAppiumServer(device, {} as EffectiveConfig);

    expect(endpoint).toEqual({ host: '10.0.0.5', port: 4823, baseUrl: 'http://10.0.0.5:4823', path: '' });
    expect(updateSpy).not.toHaveBeenCalled();
    expect(findByIdSpy).not.toHaveBeenCalled();
  });

  it('clears a stale reported endpoint and issues a fresh request when it no longer answers', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchSpy);
    const clearSpy = vi.spyOn(Device, 'findByIdAndUpdate').mockResolvedValue(null as never);
    // Resolves with a fresh endpoint on the very first poll after the
    // re-request, so this test doesn't have to wait out a real retry loop —
    // the behavior under test is the clear-then-reissue, not the polling.
    vi.spyOn(Device, 'findById').mockReturnValue({
      select: () => Promise.resolve({ remoteAppium: { host: '10.0.0.9', port: 4900, readyAt: new Date() } }),
    } as never);

    const device = fakeRemoteDevice({ remoteAppium: { host: '10.0.0.5', port: 4823, readyAt: new Date() } });
    const endpoint = await ensureRemoteAppiumServer(device, {} as EffectiveConfig);

    expect(endpoint).toEqual({ host: '10.0.0.9', port: 4900, baseUrl: 'http://10.0.0.9:4900', path: '' });
    expect(clearSpy).toHaveBeenCalledWith('device-1', { remoteAppium: null });
    expect(clearSpy).toHaveBeenCalledWith('device-1', { remoteAppiumRequestedAt: expect.any(Date) as Date });
  });

  it('returns the endpoint once the agent reports one back on a later poll', async () => {
    vi.spyOn(Device, 'findByIdAndUpdate').mockResolvedValue(null as never);
    const readyAt = new Date();
    vi.spyOn(Device, 'findById').mockReturnValue({
      select: () => Promise.resolve({ remoteAppium: { host: '10.0.0.5', port: 4823, readyAt } }),
    } as never);

    const device = fakeRemoteDevice();
    const endpoint = await ensureRemoteAppiumServer(device, {} as EffectiveConfig);

    expect(endpoint).toEqual({ host: '10.0.0.5', port: 4823, baseUrl: 'http://10.0.0.5:4823', path: '' });
  });
});

describe('getPendingAppiumRequestsForMachine', () => {
  it('only returns devices on this machine with an outstanding request and no fresh endpoint', async () => {
    const selectSpy = vi.fn().mockResolvedValue([
      { udid: 'd1', platform: 'android' },
      { udid: 'd2', platform: 'ios' },
    ]);
    const findSpy = vi.spyOn(Device, 'find').mockReturnValue({ select: selectSpy } as never);

    const pending = await getPendingAppiumRequestsForMachine('host-2');

    expect(findSpy).toHaveBeenCalledWith({ machineId: 'host-2', remoteAppiumRequestedAt: { $ne: null }, remoteAppium: null });
    expect(pending).toEqual([
      { deviceUdid: 'd1', platform: 'android' },
      { deviceUdid: 'd2', platform: 'ios' },
    ]);
  });
});

describe('reportRemoteAppiumReady', () => {
  it('records the agent-reported endpoint and clears the request marker in one update', async () => {
    const updateSpy = vi.spyOn(Device, 'findOneAndUpdate').mockResolvedValue(null as never);

    await reportRemoteAppiumReady('d1', 'host-2', '10.0.0.5', 4823);

    expect(updateSpy).toHaveBeenCalledWith(
      { udid: 'd1', machineId: 'host-2' },
      { remoteAppium: { host: '10.0.0.5', port: 4823, readyAt: expect.any(Date) as Date }, remoteAppiumRequestedAt: null },
    );
  });
});

/**
 * Regressions (2026-11-21): cleanup asked only `GET /sessions`, which Appium 2
 * removed — so on Appium 2 it silently closed nothing — and it deleted every
 * session on the server, which on a shared server kills other phones' runs.
 */
describe('closeActiveSessions — Appium 2 and shared servers', () => {
  const config = { appium: { enabled: true, host: '127.0.0.1', basePort: 4723 } } as EffectiveConfig;

  function appium2(sessions: unknown[]) {
    const fetchSpy = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
      if (url.endsWith('/status')) return Promise.resolve({ ok: true });
      if (url.endsWith('/appium/sessions')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ value: sessions }) });
      if (url.endsWith('/sessions')) return Promise.resolve({ ok: false, status: 404 }); // removed in Appium 2
      if (opts?.method === 'DELETE') return Promise.resolve({ ok: true });
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchSpy);
    return fetchSpy;
  }

  it('finds sessions on an Appium 2 server via /appium/sessions', async () => {
    const fetchSpy = appium2([{ id: 's1', capabilities: { 'appium:udid': 'd1' } }]);
    await closeActiveSessions(fakeDevice(4723), config);
    expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining('/session/s1'), expect.objectContaining({ method: 'DELETE' }));
  });

  it("leaves another device's session alone on a shared server", async () => {
    const fetchSpy = appium2([
      { id: 'mine', capabilities: { udid: 'd1' } },
      { id: 'theirs', capabilities: { 'appium:udid': 'other-phone' } },
    ]);
    await closeActiveSessions(fakeDevice(4723), config);
    const deleted = fetchSpy.mock.calls.filter(([, o]) => (o as RequestInit | undefined)?.method === 'DELETE').map(([u]) => u as string);
    expect(deleted.some((u) => u.endsWith('/session/mine'))).toBe(true);
    expect(deleted.some((u) => u.endsWith('/session/theirs'))).toBe(false);
  });
});

describe('assertDriverInstalled', () => {
  it('reports a driver listing that could not run as such, not as a missing driver', async () => {
    const path = process.env.PATH;
    process.env.PATH = ''; // `appium` cannot be found: the listing itself fails
    try {
      await expect(assertDriverInstalled('android')).rejects.toThrow(/Could not check Appium's installed drivers/);
    } finally {
      process.env.PATH = path;
    }
  });
});
