import { describe, it, expect } from 'vitest';
import { formatBytes, formatDuration, formatPercent, shortId } from './format';

describe('formatBytes', () => {
  it('renders an em dash for a missing size rather than "0 B" or "NaN"', () => {
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(undefined)).toBe('—');
  });

  it('handles zero distinctly from missing', () => {
    expect(formatBytes(0)).toBe('0 B');
  });

  it('scales through the units', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(36_000)).toBe('35 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});

describe('formatDuration', () => {
  it('returns an em dash when the run never started', () => {
    expect(formatDuration(null, null)).toBe('—');
  });

  it('formats sub-second, seconds, and minutes differently', () => {
    const t0 = '2026-01-01T00:00:00.000Z';
    expect(formatDuration(t0, '2026-01-01T00:00:00.250Z')).toBe('250 ms');
    expect(formatDuration(t0, '2026-01-01T00:00:03.500Z')).toBe('3.5s');
    expect(formatDuration(t0, '2026-01-01T00:02:05.000Z')).toBe('2m 5s');
  });

  it('never renders a negative duration from clock skew', () => {
    expect(formatDuration('2026-01-01T00:00:10.000Z', '2026-01-01T00:00:00.000Z')).toBe('—');
  });
});

describe('formatPercent', () => {
  it('rounds a 0..1 rate to whole percent', () => {
    expect(formatPercent(0)).toBe('0%');
    expect(formatPercent(0.6666)).toBe('67%');
    expect(formatPercent(1)).toBe('100%');
  });

  it('distinguishes a missing rate from zero', () => {
    expect(formatPercent(null)).toBe('—');
    expect(formatPercent(0)).toBe('0%');
  });
});

describe('shortId', () => {
  it('truncates long ids but leaves short ones alone', () => {
    expect(shortId('6a898e448d8dcd23cdd97fb1')).toBe('6a898e44…fb1');
    expect(shortId('emulator')).toBe('emulator');
  });
});
