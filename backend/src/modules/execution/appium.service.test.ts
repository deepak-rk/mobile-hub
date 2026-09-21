import { describe, it, expect, vi, afterEach } from 'vitest';
import {
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

    // Only the /status probe — never got far enough to ask for sessions.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
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

    expect(endpoint).toEqual({ host: '10.0.0.5', port: 4823, baseUrl: 'http://10.0.0.5:4823' });
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

    expect(endpoint).toEqual({ host: '10.0.0.9', port: 4900, baseUrl: 'http://10.0.0.9:4900' });
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

    expect(endpoint).toEqual({ host: '10.0.0.5', port: 4823, baseUrl: 'http://10.0.0.5:4823' });
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
