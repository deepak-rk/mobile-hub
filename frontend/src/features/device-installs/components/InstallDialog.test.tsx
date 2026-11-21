import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '@/services/api';
import type { Device } from '@/features/devices/types';
import type { Build } from '../../builds/types';
import { InstallDialog } from './InstallDialog';

vi.mock('@/services/api', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
vi.mock('../api/useInstallRunStream', () => ({ useInstallRunStream: () => ({ state: 'idle' }) }));

const get = vi.mocked(api.get);
const post = vi.mocked(api.post);

beforeAll(() => {
  // jsdom has no <dialog> modal support; the design kit's Dialog calls these.
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});

function device(overrides: Partial<Device>): Device {
  return {
    _id: overrides.udid ?? 'id',
    udid: 'udid',
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

const build = { _id: 'b1', project: 'app', version: '1.0', platform: 'android' } as Build;

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function respond(devices: Promise<Device[]>) {
  get.mockImplementation(async (url: string) => {
    if (url === '/devices') return { data: await devices };
    if (url.endsWith('/devices')) return { data: [] }; // installed-on list
    throw new Error(`unexpected GET ${url}`);
  });
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  get.mockReset();
  post.mockReset();
});

describe('InstallDialog', () => {
  it('does not claim "No matching devices" while the device list is still loading', async () => {
    respond(new Promise(() => {})); // never resolves
    render(<InstallDialog build={build} onClose={() => {}} />, { wrapper });

    expect(await screen.findByText(/Loading devices/)).toBeInTheDocument();
    expect(screen.queryByText(/No matching devices found/)).not.toBeInTheDocument();
  });

  it('says the list failed rather than that it is empty when the fetch errors', async () => {
    respond(Promise.reject(new Error('boom')));
    render(<InstallDialog build={build} onClose={() => {}} />, { wrapper });

    expect(await screen.findByText(/Could not load devices/)).toBeInTheDocument();
    expect(screen.queryByText(/No matching devices found/)).not.toBeInTheDocument();
  });

  it('disables unreachable devices, not only offline ones', async () => {
    respond(
      Promise.resolve([
        device({ udid: 'a', name: 'Up', status: 'idle' }),
        device({ udid: 'b', name: 'Gone', status: 'unreachable' }),
      ]),
    );
    render(<InstallDialog build={build} onClose={() => {}} />, { wrapper });

    expect(await screen.findByRole('checkbox', { name: /Gone/ })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /Up/ })).toBeEnabled();
  });

  it('drops a ticked device that went offline from the count and the submission', async () => {
    let devices = [
      device({ udid: 'a', name: 'Stays', status: 'idle' }),
      device({ udid: 'b', name: 'Drops', status: 'idle' }),
    ];
    get.mockImplementation(async (url: string) => (url === '/devices' ? { data: devices } : { data: [] }));
    post.mockResolvedValue({ data: { _id: 'run-1', targets: [] } });
    const user = userEvent.setup();
    render(<InstallDialog build={build} onClose={() => {}} />, { wrapper });

    await user.click(await screen.findByRole('checkbox', { name: /Stays/ }));
    await user.click(screen.getByRole('checkbox', { name: /Drops/ }));
    expect(screen.getByRole('button', { name: 'Install to 2 devices' })).toBeEnabled();

    devices = [devices[0], { ...devices[1], status: 'offline' }];
    await client.invalidateQueries({ queryKey: ['devices'] });
    await waitFor(() => expect(screen.getByRole('checkbox', { name: /Drops/ })).toBeDisabled());
    expect(screen.getByRole('checkbox', { name: /Drops/ })).not.toBeChecked();

    await user.click(screen.getByRole('button', { name: 'Install to 1 device' }));
    expect(post).toHaveBeenCalledWith('/device-installs', {
      buildId: 'b1',
      devices: [{ udid: 'a', machineId: 'host-1' }],
    });
  });
});
