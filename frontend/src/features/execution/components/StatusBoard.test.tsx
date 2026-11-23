import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { StatusBoard } from './StatusBoard';
import type { StatusTree } from '../api/execution.api';

const tree: StatusTree = {
  groups: [
    {
      platform: 'android',
      variant: 'eu',
      status: 'partial',
      features: [
        {
          spec: 'test/features/login.feature',
          status: 'partial',
          scenarios: [
            {
              testId: 'a',
              title: 'Signs in',
              status: 'completed',
              runId: 'r2',
              updatedAt: new Date().toISOString(),
              history: [
                { runId: 'r1', status: 'failed', at: new Date().toISOString() },
                { runId: 'r2', status: 'completed', at: new Date().toISOString() },
              ],
            },
            { testId: 'b', title: 'Signs out', status: 'ready', runId: 'r2', updatedAt: new Date().toISOString(), history: [] },
          ],
        },
      ],
    },
  ],
};

vi.mock('../api/execution.api', () => ({
  useStatusTree: () => ({ data: tree, isPending: false, error: null, refetch: vi.fn() }),
  useClearStuck: () => ({ mutate: vi.fn(), isPending: false, data: undefined }),
}));
vi.mock('@/features/auth/useAuth', () => ({ useAuth: () => ({ can: () => true }) }));

describe('StatusBoard', () => {
  it('shows the group, feature and scenarios with their states and result history', () => {
    render(<StatusBoard project="p" />, { wrapper: MemoryRouter });

    expect(screen.getByText('android · eu')).toBeInTheDocument();
    expect(screen.getByText('test/features/login.feature')).toBeInTheDocument();
    expect(screen.getByText('Signs in')).toBeInTheDocument();
    // `ready` reads as "Not run", never as the green "Ready" of a build.
    expect(screen.getByText('Not run')).toBeInTheDocument();
    expect(screen.queryByText('Ready')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Last 2 results').querySelectorAll('a')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Clear stuck' })).toBeInTheDocument();
  });
});
