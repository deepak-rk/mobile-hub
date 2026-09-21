import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { DeviceCard } from './DevicesPage';
import type { Device } from '../types';

/**
 * Regression for a real multi-view dead end: entering picking mode hid every
 * card's "View live" link, so with fewer than 2 online devices (or before
 * selecting a second one) there was no way to view any device at all short of
 * cancelling the picker first. Fixed by keeping "View live" visible during
 * picking too, with its click stopping propagation so it doesn't also toggle
 * the enclosing <label>'s checkbox.
 */
function device(overrides: Partial<Device> = {}): Device {
  return {
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
    ...overrides,
  };
}

function renderCard(props: Partial<React.ComponentProps<typeof DeviceCard>> = {}) {
  return render(
    <MemoryRouter>
      <DeviceCard
        device={device()}
        selectable={false}
        selected={false}
        selectionFull={false}
        onToggle={vi.fn()}
        {...props}
      />
    </MemoryRouter>,
  );
}

describe('DeviceCard', () => {
  it('shows "View live" when not in picking mode', () => {
    renderCard({ selectable: false });
    expect(screen.getByRole('link', { name: /view live/i })).toBeInTheDocument();
  });

  it('still shows "View live" while picking — the dead-end regression', () => {
    renderCard({ selectable: true, selected: false });
    expect(screen.getByRole('link', { name: /view live/i })).toBeInTheDocument();
  });

  it('clicking "View live" while picking does not also toggle selection', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    renderCard({ selectable: true, selected: false, onToggle });

    await user.click(screen.getByRole('link', { name: /view live/i }));

    expect(onToggle).not.toHaveBeenCalled();
  });

  it('the checkbox itself still toggles selection normally while picking', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    renderCard({ selectable: true, selected: false, onToggle });

    await user.click(screen.getByRole('checkbox'));

    expect(onToggle).toHaveBeenCalledWith('emulator-5554');
  });

  it('hides "View live" for an offline device, picking or not', () => {
    renderCard({ device: device({ status: 'offline' }), selectable: true });
    expect(screen.queryByRole('link', { name: /view live/i })).not.toBeInTheDocument();
  });
});
