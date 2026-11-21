import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { api } from '@/services/api';
import { useFeatureDisabled, type FeatureToggles } from './api/features.api';
import { FeatureGate } from './components/FeatureGate';
import { AppShell } from '@/app/AppShell';
import { AuthContext, type AuthContextValue } from '@/features/auth/authContext';

vi.mock('@/services/api', () => ({ api: { get: vi.fn() } }));
const get = vi.mocked(api.get);

const ALL_ON: FeatureToggles = { builds: true, execution: true, analytics: true, streaming: true };

const auth: AuthContextValue = {
  user: null,
  isLoading: false,
  login: vi.fn(),
  register: vi.fn(),
  logout: vi.fn(),
  can: () => false,
};

function wrapper({ children }: { children: ReactNode }) {
  // A fresh client per render, no retries: a failed request must settle to
  // the error state at once instead of retrying behind the test's back.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <AuthContext.Provider value={auth}>
        <MemoryRouter>{children}</MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>
  );
}

function respond(toggles: FeatureToggles) {
  get.mockResolvedValue({ data: toggles });
}

beforeEach(() => {
  get.mockReset();
});

describe('useFeatureDisabled', () => {
  it('reads the toggles from GET /config/features', async () => {
    respond({ ...ALL_ON, analytics: false });
    const { result } = renderHook(() => useFeatureDisabled('analytics'), { wrapper });

    await waitFor(() => expect(result.current).toBe(true));
    expect(get).toHaveBeenCalledWith('/config/features');
  });

  it('is false for a module that is on', async () => {
    respond({ ...ALL_ON, analytics: false });
    const { result } = renderHook(() => ({ builds: useFeatureDisabled('builds'), off: useFeatureDisabled('analytics') }), {
      wrapper,
    });

    await waitFor(() => expect(result.current.off).toBe(true));
    expect(result.current.builds).toBe(false);
  });

  it('is false while loading — unknown is not disabled', () => {
    get.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useFeatureDisabled('analytics'), { wrapper });

    expect(result.current).toBe(false);
  });

  it('is false when the request fails — unknown is not disabled', async () => {
    get.mockRejectedValue({ code: 'NETWORK', message: 'down' });
    const { result } = renderHook(() => useFeatureDisabled('analytics'), { wrapper });

    await waitFor(() => expect(get).toHaveBeenCalled());
    // Let the rejection settle before asserting it still reads as enabled.
    await new Promise((r) => setTimeout(r, 0));
    expect(result.current).toBe(false);
  });
});

describe('FeatureGate', () => {
  it('shows the disabled state instead of the page for a module that is off', async () => {
    respond({ ...ALL_ON, builds: false });
    render(
      <FeatureGate feature="builds">
        <p>builds page</p>
      </FeatureGate>,
      { wrapper },
    );

    expect(await screen.findByText(/this module is disabled for your organisation/i)).toBeInTheDocument();
    expect(screen.queryByText('builds page')).not.toBeInTheDocument();
  });

  it('renders the page while the toggles are still loading', () => {
    get.mockReturnValue(new Promise(() => {}));
    render(
      <FeatureGate feature="builds">
        <p>builds page</p>
      </FeatureGate>,
      { wrapper },
    );

    expect(screen.getByText('builds page')).toBeInTheDocument();
  });
});

describe('AppShell nav', () => {
  const navLinks = () =>
    screen
      .getAllByRole('link')
      .map((a) => a.textContent)
      .filter(Boolean);

  it('hides the nav entries of disabled modules, keeping core ones', async () => {
    respond({ builds: true, execution: false, analytics: false, streaming: true });
    render(<AppShell />, { wrapper });

    await waitFor(() => expect(screen.queryByRole('link', { name: /analytics/i })).not.toBeInTheDocument());
    expect(screen.queryByRole('link', { name: /execution/i })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /builds/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /devices/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /hosts/i })).toBeInTheDocument();
  });

  it('shows every entry while the toggles are loading', () => {
    get.mockReturnValue(new Promise(() => {}));
    render(<AppShell />, { wrapper });

    expect(navLinks()).toEqual(expect.arrayContaining(['Devices', 'Builds', 'Execution', 'Analytics', 'Hosts']));
  });

  it('shows every entry when the toggles request fails', async () => {
    get.mockRejectedValue({ code: 'NETWORK', message: 'down' });
    render(<AppShell />, { wrapper });

    await waitFor(() => expect(get).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(navLinks()).toEqual(expect.arrayContaining(['Devices', 'Builds', 'Execution', 'Analytics', 'Hosts']));
  });
});
