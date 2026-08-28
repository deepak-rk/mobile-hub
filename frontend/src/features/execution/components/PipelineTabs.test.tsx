import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PipelineTabs } from './PipelineTabs';

describe('PipelineTabs', () => {
  it('marks the active tab pressed and the others not', () => {
    render(<PipelineTabs active="current" onChange={() => {}} currentCount={2} historyCount={5} />);

    expect(screen.getByRole('button', { name: /^Trigger$/ })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: /^Current/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /^History/ })).toHaveAttribute('aria-pressed', 'false');
  });

  it('shows the real counts on Current and History', () => {
    render(<PipelineTabs active="trigger" onChange={() => {}} currentCount={3} historyCount={42} />);

    expect(screen.getByRole('button', { name: 'Current (3)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'History (42)' })).toBeInTheDocument();
  });

  it('calls onChange with the clicked tab', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PipelineTabs active="current" onChange={onChange} currentCount={0} historyCount={0} />);

    await user.click(screen.getByRole('button', { name: /^History/ }));

    expect(onChange).toHaveBeenCalledWith('history');
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('clicking the already-active tab still fires onChange (caller decides idempotency)', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PipelineTabs active="trigger" onChange={onChange} currentCount={0} historyCount={0} />);

    await user.click(screen.getByRole('button', { name: /^Trigger$/ }));

    expect(onChange).toHaveBeenCalledWith('trigger');
  });
});
