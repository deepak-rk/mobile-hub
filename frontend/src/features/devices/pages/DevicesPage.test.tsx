import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { api } from '@/services/api';
import { DevicesPage } from './DevicesPage';
import { DeviceViewerPage } from './DeviceViewerPage';
import type { Device } from '../types';

vi.mock('@/services/api', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
// The viewer page's own children are irrelevant here — only which device it asks for.
vi.mock('../components/DeviceStream', () => ({ DeviceStream: () => null, StreamStopButton: () => null }));
vi.mock('../components/LockControls', () => ({ LockControls: () => null }));
vi.mock('../components/AppiumCapabilities', () => ({ AppiumCapabilities: () => null }));
vi.mock('@/features/auth/useAuth', () => ({ useAuth: () => ({ user: null, can: () => false }) }));

const get = vi.mocked(api.get);

function device(overrides: Partial<Device>): Device {
  return {
    _id: `${overrides.machineId ?? 'host-1'}-${overrides.udid ?? 'emulator-5554'}`,
    udid: 'emulator-5554',
    machineId: 'host-1',
    platform: 'android',
    name: 'Pixel',
    osVersion: '14',
    model: 'Pixel',
    connectionType: 'emulator',
    status: 'idle',
    lock: null,
    isLocallyReachable: true,
    lastSeenAt: '2026-08-20T00:00:00.000Z',
    ...overrides,
  };
}

function renderAt(url: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/devices" element={<DevicesPage />} />
          <Route path="/devices/:udid" element={<DeviceViewerPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  get.mockReset();
  window.history.replaceState(null, '', '/');
});

describe('DevicesPage filter chips', () => {
  /**
   * Regression: chip counts came from the server-filtered list, so with
   * status=idle every other chip read 0 ("Offline 0") whatever the real number.
   */
  it('counts from the whole inventory, not the filtered list', async () => {
    const all = [
      device({ udid: 'a', status: 'idle' }),
      device({ udid: 'b', status: 'offline' }),
      device({ udid: 'c', status: 'offline' }),
    ];
    get.mockImplementation(async (_url, config) => {
      const status = (config?.params as { status?: string } | undefined)?.status;
      return { data: status ? all.filter((d) => d.status === status) : all };
    });

    // The filter hooks read window.location, not the router's location.
    window.history.replaceState(null, '', '/devices?status=idle');
    renderAt('/devices?status=idle');

    expect(await screen.findByRole('button', { name: 'Offline 2' })).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/devices', { params: { status: 'idle' } });
    expect(screen.getByRole('button', { name: 'Idle 1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'All 3' })).toBeInTheDocument();
  });
});

describe('DevicesPage multi-view selection', () => {
  /** Regression: selection was keyed by udid, so ticking one host's emulator-5554 ticked every host's. */
  it('selects one host’s device without selecting the same udid on another host', async () => {
    get.mockResolvedValue({
      data: [
        device({ machineId: 'host-a', name: 'Emu A' }),
        device({ machineId: 'host-b', name: 'Emu B' }),
      ],
    });
    const user = userEvent.setup();
    renderAt('/devices');

    await user.click(await screen.findByRole('button', { name: /Multi-view/ }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Emu A for multi-view' }));

    expect(screen.getByRole('checkbox', { name: 'Select Emu A for multi-view' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Select Emu B for multi-view' })).not.toBeChecked();
    expect(screen.getByText(/1\/3 selected/)).toBeInTheDocument();
  });
});

describe('DeviceViewerPage', () => {
  it('fetches the device on the host named by ?machineId=', async () => {
    get.mockResolvedValue({ data: device({ machineId: 'host-b', name: 'Emu B' }) });
    renderAt('/devices/emulator-5554?machineId=host-b');

    expect(await screen.findByRole('heading', { name: 'Emu B' })).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/devices/emulator-5554', { params: { machineId: 'host-b' } });
  });
});

describe('DevicesPage when the hub does not answer', () => {
  const unreachable = { code: 'NETWORK_ERROR', message: 'Network error' };

  it('says it cannot reach the hub, not "Network error"', async () => {
    get.mockRejectedValue(unreachable);
    renderAt('/devices');
    expect(await screen.findByText("Can't reach the hub")).toBeInTheDocument();
    expect(screen.queryByText('Network error')).not.toBeInTheDocument();
  });

  it('keeps the list it has when a refresh fails, with a note', async () => {
    get.mockResolvedValue({ data: [device({ name: 'Kept Pixel' })] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/devices']}>
          <Routes>
            <Route path="/devices" element={<DevicesPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findAllByText('Kept Pixel')).not.toHaveLength(0);
    get.mockRejectedValue(unreachable);
    await client.refetchQueries();
    expect(await screen.findByText(/Can't reach the hub; showing the list from/)).toBeInTheDocument();
    expect(screen.getAllByText('Kept Pixel')).not.toHaveLength(0);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
