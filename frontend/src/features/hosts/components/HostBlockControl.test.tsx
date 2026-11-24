import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HostBlockControl } from './HostBlockControl';
import type { Host } from '../types';

const mutate = vi.fn();
vi.mock('../api/hosts.api', () => ({
  useSetHostBlocked: () => ({ mutate, isPending: false, error: null }),
}));

const host = { machineId: 'host-a', hostname: 'lab-1', blocked: null } as unknown as Host;

describe('HostBlockControl', () => {
  beforeAll(() => {
    // jsdom has no modal <dialog>; the kit's Dialog calls these.
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.open = true;
    };
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
      this.open = false;
    };
  });
  beforeEach(() => mutate.mockReset());

  it('asks before removing, and sends the reason', async () => {
    render(<HostBlockControl host={host} />);
    await userEvent.click(screen.getByRole('button', { name: 'Remove from lab' }));
    expect(mutate).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText('Reason (optional)'), '  decommissioned ');
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(mutate).toHaveBeenCalledWith({ blocked: true, reason: 'decommissioned' });
  });

  it('a removed host shows when and why, and can be let back in', async () => {
    render(<HostBlockControl host={{ ...host, blocked: { at: new Date().toISOString(), by: 'a', reason: 'broken USB hub' } }} />);
    expect(screen.getByText(/broken USB hub/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Let back in' }));
    expect(mutate).toHaveBeenCalledWith({ blocked: false });
  });
});
