import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FilterChips } from './FilterChips';
import type { Device } from '../types';

function device(overrides: Partial<Device>): Device {
  return {
    _id: overrides._id ?? 'id',
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

const devices: Device[] = [
  device({ _id: '1', status: 'idle', platform: 'android' }),
  device({ _id: '2', status: 'in-use', platform: 'android' }),
  device({ _id: '3', status: 'offline', platform: 'ios' }),
];

describe('FilterChips', () => {
  it('shows a real count per chip', () => {
    render(<FilterChips devices={devices} status="all" setStatus={() => {}} platform="all" setPlatform={() => {}} />);

    expect(screen.getByRole('button', { name: 'All 3' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Idle 1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'In use 1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Offline 1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Android 2' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'iOS 1' })).toBeInTheDocument();
  });

  it('marks the chip matching current filters as pressed', () => {
    render(
      <FilterChips devices={devices} status="idle" setStatus={() => {}} platform="all" setPlatform={() => {}} />,
    );

    expect(screen.getByRole('button', { name: 'Idle 1' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'All 3' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('clicking a status chip sets that status', async () => {
    const user = userEvent.setup();
    const setStatus = vi.fn();
    render(
      <FilterChips devices={devices} status="all" setStatus={setStatus} platform="all" setPlatform={() => {}} />,
    );

    await user.click(screen.getByRole('button', { name: 'Offline 1' }));

    expect(setStatus).toHaveBeenCalledWith('offline');
  });

  it('clicking the already-active status chip toggles back to all', async () => {
    const user = userEvent.setup();
    const setStatus = vi.fn();
    render(
      <FilterChips devices={devices} status="idle" setStatus={setStatus} platform="all" setPlatform={() => {}} />,
    );

    await user.click(screen.getByRole('button', { name: 'Idle 1' }));

    expect(setStatus).toHaveBeenCalledWith('all');
  });

  it('clicking All resets both status and platform', async () => {
    const user = userEvent.setup();
    const setStatus = vi.fn();
    const setPlatform = vi.fn();
    render(
      <FilterChips devices={devices} status="idle" setStatus={setStatus} platform="ios" setPlatform={setPlatform} />,
    );

    await user.click(screen.getByRole('button', { name: 'All 3' }));

    expect(setStatus).toHaveBeenCalledWith('all');
    expect(setPlatform).toHaveBeenCalledWith('all');
  });

  it('clicking a platform chip sets that platform independently of status', async () => {
    const user = userEvent.setup();
    const setPlatform = vi.fn();
    render(
      <FilterChips devices={devices} status="all" setStatus={() => {}} platform="all" setPlatform={setPlatform} />,
    );

    await user.click(screen.getByRole('button', { name: 'iOS 1' }));

    expect(setPlatform).toHaveBeenCalledWith('ios');
  });
});
