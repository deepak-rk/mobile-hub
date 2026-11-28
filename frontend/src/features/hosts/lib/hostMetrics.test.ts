import { describe, it, expect } from 'vitest';
import { memoryUse, protocolState } from './hostMetrics';

const diag = { diskFreeBytes: null, diskTotalBytes: null, nodeVersion: null };

describe('memoryUse', () => {
  it('computes used percent from total and free', () => {
    expect(memoryUse({ ...diag, memTotalBytes: 8e9, memFreeBytes: 2e9 }).usedPercent).toBe(75);
  });
  it('is unknown, not 0 %, when either number is missing', () => {
    expect(memoryUse(diag).usedPercent).toBeNull();
    expect(memoryUse({ ...diag, memTotalBytes: 8e9, memFreeBytes: null }).usedPercent).toBeNull();
    expect(memoryUse({ ...diag, memTotalBytes: 0, memFreeBytes: 0 }).usedPercent).toBeNull();
  });
});

describe('protocolState', () => {
  it('compares agent and hub versions', () => {
    expect(protocolState(1, 1)).toBe('match');
    expect(protocolState(1, 2)).toBe('agent-older');
    expect(protocolState(3, 2)).toBe('agent-newer');
  });
  it('is unknown when either side did not report one', () => {
    expect(protocolState(null, 1)).toBe('unknown');
    expect(protocolState(undefined, 1)).toBe('unknown');
    expect(protocolState(1, undefined)).toBe('unknown');
  });
});
