import { describe, it, expect } from 'vitest';
import type * as os from 'os';
import { collectDiagnostics, createCpuSampler } from './diagnostics';

const cpu = (idle: number, busy: number): os.CpuInfo => ({
  model: 'x',
  speed: 1,
  times: { user: busy, nice: 0, sys: 0, idle, irq: 0 },
});

describe('createCpuSampler', () => {
  it('returns null on the first sample instead of the since-boot average', () => {
    const sample = createCpuSampler(() => [cpu(900, 100)]);
    expect(sample()).toBeNull();
  });

  it('measures busy time between two samples across all cores', () => {
    const readings = [
      [cpu(1000, 1000), cpu(1000, 1000)],
      // core 1: +75 busy, +25 idle; core 2: +25 busy, +75 idle -> 100 busy of 200
      [cpu(1025, 1075), cpu(1075, 1025)],
      // both cores fully idle
      [cpu(1125, 1075), cpu(1175, 1025)],
    ];
    let i = 0;
    const sample = createCpuSampler(() => readings[i++]);
    expect(sample()).toBeNull();
    expect(sample()).toBe(50);
    expect(sample()).toBe(0);
  });

  it('is null when no time passed or no CPUs are reported', () => {
    const same = createCpuSampler(() => [cpu(10, 10)]);
    same();
    expect(same()).toBeNull();
    expect(createCpuSampler(() => [])()).toBeNull();
  });
});

describe('collectDiagnostics', () => {
  it('reports null CPU when the sampler throws, and real memory numbers', async () => {
    const d = await collectDiagnostics(() => {
      throw new Error('boom');
    });
    expect(d.cpuPercent).toBeNull();
    expect(d.memTotalBytes).toBeGreaterThan(0);
    expect(d.memFreeBytes).toBeGreaterThan(0);
    expect(d.cpuCount).toBeGreaterThan(0);
  });
});
