import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { InventorySummary } from './InventorySummary';
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

describe('InventorySummary', () => {
  it('counts total/online/in-use/offline correctly for a mixed list', () => {
    const devices: Device[] = [
      device({ _id: '1', status: 'idle' }),
      device({ _id: '2', status: 'in-use' }),
      device({ _id: '3', status: 'in-use' }),
      device({ _id: '4', status: 'offline' }),
      device({ _id: '5', status: 'unreachable' }),
      device({ _id: '6', status: 'smoke' }), // online (not offline/unreachable), not idle/in-use
    ];

    render(<InventorySummary devices={devices} />);

    const group = screen.getByRole('group', { name: 'Device inventory summary' });
    // total 6, online 4 (idle + in-use×2 + smoke), in use 2, offline 2 (offline + unreachable).
    // Icons render nothing (aria-hidden), so value+label concatenate directly in document order.
    expect(group.textContent).toBe('6total4online2in use2offline');
  });

  it('renders zeroes rather than omitting a row when there are no devices in a bucket', () => {
    render(<InventorySummary devices={[device({ status: 'idle' })]} />);

    const group = screen.getByRole('group', { name: 'Device inventory summary' });
    expect(group.textContent).toContain('0in use');
    expect(group.textContent).toContain('0offline');
  });
});
