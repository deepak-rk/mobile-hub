import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { MultiViewTile } from './MultiViewTile';
import type { Device } from '../types';

/**
 * Regression for the "sourceHost per tile" gap: once streaming capture-
 * locality shipped, tiles in one multi-view grid can each be served by a
 * different host's agent, and there was no UI element saying which.
 */
vi.mock('../api/useDeviceStream', () => ({
  useDeviceStream: () => ({ state: 'connecting', frameUrl: null, lastError: null, closeReason: null }),
}));

function device(overrides: Partial<Device> = {}): Device {
  return {
    _id: 'id',
    udid: 'emulator-5554',
    machineId: 'dev-host',
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

function renderTile(overrides: Partial<Device> = {}) {
  return render(
    <MemoryRouter>
      <MultiViewTile device={device(overrides)} onRemove={vi.fn()} />
    </MemoryRouter>,
  );
}

describe('MultiViewTile', () => {
  it("shows the owning machine's id", () => {
    renderTile({ machineId: 'dev-host' });
    expect(screen.getByText('dev-host')).toBeInTheDocument();
  });

  it('reflects a different tile in the same grid coming from a different host', () => {
    renderTile({ machineId: 'agent-2' });
    expect(screen.getByText('agent-2')).toBeInTheDocument();
    expect(screen.queryByText('dev-host')).not.toBeInTheDocument();
  });
});
