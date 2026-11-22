import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '@/services/api';
import { useSuites } from './execution.api';

vi.mock('@/services/api', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
const get = vi.mocked(api.get);

type GetConfig = { params?: unknown } | undefined;
const branchOf = (config: GetConfig): string | undefined => {
  const params = config?.params;
  return params && typeof params === 'object' && 'branch' in params && typeof params.branch === 'string'
    ? params.branch
    : undefined;
};

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  get.mockReset();
  get.mockImplementation(async (_url: string, config?: GetConfig) => {
    const id = branchOf(config) ?? 'default';
    return { data: { suites: [{ id, name: id, kind: 'tag' }] } };
  });
});

/**
 * Suites are read from the branch the run will execute, so changing the
 * branch must refetch rather than keep showing another branch's suites.
 */
describe('useSuites', () => {
  it('reads the default branch when no branch is given', async () => {
    const { result } = renderHook(() => useSuites('app'), { wrapper });
    await waitFor(() => expect(result.current.data?.suites[0].id).toBe('default'));
    expect(get).toHaveBeenCalledWith('/execution/projects/app/suites', { params: undefined });
  });

  it('refetches for the new branch once it settles, not per keystroke', async () => {
    const { result, rerender } = renderHook(({ branch }) => useSuites('app', branch), {
      wrapper,
      initialProps: { branch: 'main' },
    });
    await waitFor(() => expect(result.current.data?.suites[0].id).toBe('main'));

    rerender({ branch: 'feat' });
    rerender({ branch: 'feature/x' });
    await waitFor(() => expect(result.current.data?.suites[0].id).toBe('feature/x'));

    const branchesFetched = get.mock.calls.map(([, config]) => branchOf(config));
    expect(branchesFetched).toEqual(['main', 'feature/x']);
  });
});
