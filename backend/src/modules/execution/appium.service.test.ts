import { describe, it, expect, vi, afterEach } from 'vitest';
import { closeActiveSessions } from './appium.service';
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
