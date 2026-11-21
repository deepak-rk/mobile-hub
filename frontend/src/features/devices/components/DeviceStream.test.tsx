import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { api } from '@/services/api';
import { AuthContext, type AuthContextValue } from '@/features/auth/authContext';
import { useDeviceStream } from '../api/useDeviceStream';
import { DeviceStream } from './DeviceStream';
import type { Device } from '../types';

vi.mock('@/services/api', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
vi.mock('../api/useDeviceStream', () => ({
  useDeviceStream: vi.fn(() => ({
    state: 'idle',
    frameUrl: null,
    restarted: false,
    dismissRestarted: vi.fn(),
    lastError: null,
    closeReason: null,
  })),
}));

const get = vi.mocked(api.get);
const streamHook = vi.mocked(useDeviceStream);

const device: Device = {
  _id: 'id',
  udid: 'emulator-5554',
  machineId: 'host-1',
  platform: 'android',
  name: 'Pixel 3a',
  osVersion: '14',
  model: 'Pixel',
  connectionType: 'emulator',
  status: 'idle',
  lock: null,
  isLocallyReachable: true,
  lastSeenAt: '2026-08-20T00:00:00.000Z',
};

const auth: AuthContextValue = {
  user: { id: 'u1', email: 'a@example.com', name: 'A', role: 'operator' },
  isLoading: false,
  login: vi.fn(),
  register: vi.fn(),
  logout: vi.fn(),
  can: () => true,
};

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <AuthContext.Provider value={auth}>
        <MemoryRouter>{children}</MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>
  );
}

/** The `enabled` argument of the most recent useDeviceStream call. */
const lastEnabled = () => streamHook.mock.calls.at(-1)?.[1];

beforeEach(() => {
  get.mockReset();
  streamHook.mockClear();
});

describe('DeviceStream with streaming toggled', () => {
  it('shows the panel as disabled and never connects when streaming is off', async () => {
    get.mockResolvedValue({ data: { builds: true, execution: true, analytics: true, streaming: false } });
    render(<DeviceStream device={device} />, { wrapper });

    expect(await screen.findByText(/live view is disabled for your organisation/i)).toBeInTheDocument();
    expect(lastEnabled()).toBe(false);
    expect(screen.queryByRole('button', { name: /live view/i })).not.toBeInTheDocument();
  });

  it('connects as normal while the toggles are still loading', () => {
    get.mockReturnValue(new Promise(() => {}));
    render(<DeviceStream device={device} />, { wrapper });

    expect(lastEnabled()).toBe(true);
    expect(screen.queryByText(/disabled for your organisation/i)).not.toBeInTheDocument();
  });

  it('connects when streaming is on', async () => {
    get.mockResolvedValue({ data: { builds: true, execution: true, analytics: true, streaming: true } });
    render(<DeviceStream device={device} />, { wrapper });

    await waitFor(() => expect(get).toHaveBeenCalledWith('/config/features'));
    expect(lastEnabled()).toBe(true);
    expect(screen.getByRole('button', { name: /stop live view/i })).toBeInTheDocument();
  });
});
