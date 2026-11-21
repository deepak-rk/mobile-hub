import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '@/services/api';
import { useInstalledDevices, useInstallRun, useUninstallRuns } from './device-installs.api';

vi.mock('@/services/api', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
const get = vi.mocked(api.get);

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const installedRow = { deviceUdid: 'emulator-5554', machineId: 'host-a', deviceName: 'Pixel', installRunId: 'i1' };

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  get.mockReset();
});

/**
 * Regression: the "Installed on" list was invalidated only when the
 * uninstall/install was *accepted* — before the agent had done anything — so
 * the refetch still returned the device and nothing refetched afterwards.
 * It must refresh once the run reaches a terminal state.
 */
describe('"Installed on" refresh when a run finishes', () => {
  it('refetches the installed list once a watched uninstall run is terminal', async () => {
    let uninstallStatus = 'queued';
    let installed = [installedRow];
    get.mockImplementation(async (url: string) => {
      if (url === '/device-installs/uninstalls/u1') {
        return { data: { _id: 'u1', targets: [{ deviceUdid: 'emulator-5554', machineId: 'host-a', status: uninstallStatus }] } };
      }
      if (url === '/device-installs/builds/b1/devices') return { data: installed };
      throw new Error(`unexpected GET ${url}`);
    });

    const { result } = renderHook(
      () => ({ installed: useInstalledDevices('b1'), runs: useUninstallRuns(['u1']) }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.installed.data).toHaveLength(1));

    // The agent finishes: the next poll sees `done`, and only then is the list re-derived.
    uninstallStatus = 'done';
    installed = [];
    await waitFor(() => expect(result.current.installed.data).toEqual([]), { timeout: 3000 });
  });

  it('refetches the installed list once an install run is terminal', async () => {
    let installStatus = 'installing';
    let installed: (typeof installedRow)[] = [];
    get.mockImplementation(async (url: string) => {
      if (url === '/device-installs/i1') {
        return { data: { _id: 'i1', targets: [{ deviceUdid: 'emulator-5554', machineId: 'host-a', status: installStatus }] } };
      }
      if (url === '/device-installs/builds/b1/devices') return { data: installed };
      throw new Error(`unexpected GET ${url}`);
    });

    const { result } = renderHook(() => ({ installed: useInstalledDevices('b1'), run: useInstallRun('i1') }), {
      wrapper,
    });
    await waitFor(() => expect(result.current.installed.data).toEqual([]));

    installStatus = 'done';
    installed = [installedRow];
    await waitFor(() => expect(result.current.installed.data).toHaveLength(1), { timeout: 3000 });
  });
});
