import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { RunTable } from './RunTable';
import type { ExecutionRun } from '../types';

const run = (id: string) =>
  ({
    _id: id,
    status: 'failed',
    project: 'p',
    suite: '@smoke',
    branch: 'main',
    deviceUdid: 'emulator-5554',
    startedAt: null,
    endedAt: null,
    createdAt: new Date().toISOString(),
    queuePosition: null,
  }) as unknown as ExecutionRun;

describe('RunTable selection', () => {
  it('has no checkboxes without a selection', () => {
    render(<RunTable runs={[run('a')]} />, { wrapper: MemoryRouter });
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('toggles one run, and all runs from the header', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    const onToggleAll = vi.fn();
    render(<RunTable runs={[run('a'), run('b')]} selection={{ selected: new Set(['a']), onToggle, onToggleAll }} />, {
      wrapper: MemoryRouter,
    });

    expect(screen.getByRole('checkbox', { name: 'Select run a' })).toBeChecked();
    await user.click(screen.getByRole('checkbox', { name: 'Select run b' }));
    expect(onToggle).toHaveBeenCalledWith('b');
    await user.click(screen.getByRole('checkbox', { name: 'Select all runs' }));
    expect(onToggleAll).toHaveBeenCalledWith(['a', 'b'], true);
  });
});
