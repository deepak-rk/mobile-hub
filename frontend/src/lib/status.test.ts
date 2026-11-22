import { describe, it, expect } from 'vitest';
import { getStatusMeta, installTargetBadgeStatus, statusMeta } from './status';

describe('getStatusMeta', () => {
  it('gives every status a label, a colour token and an icon', () => {
    // Guidelines §7: status is never colour-only — each entry must carry an
    // icon and text so meaning survives greyscale and screen readers.
    for (const [key, meta] of Object.entries(statusMeta)) {
      expect(meta.label, `${key} label`).toBeTruthy();
      expect(meta.token, `${key} token`).toMatch(/^--status-/);
      expect(meta.icon, `${key} icon`).toBeTruthy();
    }
  });

  it('marks only genuinely continuous states as active', () => {
    expect(getStatusMeta('running').active).toBe(true);
    expect(getStatusMeta('downloading').active).toBe(true);
    expect(getStatusMeta('passed').active).toBeUndefined();
    expect(getStatusMeta('idle').active).toBeUndefined();
  });

  it('falls back to a usable badge for an unknown status instead of crashing', () => {
    const meta = getStatusMeta('some-future-status');
    expect(meta.label).toBe('some-future-status');
    expect(meta.token).toMatch(/^--status-/);
    expect(meta.icon).toBeTruthy();
  });
});

describe('installTargetBadgeStatus', () => {
  it('reads a done target with a note as success-with-warning', () => {
    expect(installTargetBadgeStatus({ status: 'done', error: 'Installed, but unverified' })).toBe('done-warning');
    expect(getStatusMeta('done-warning').label).toBe('Done with warning');
  });

  it('leaves a clean done target, and every other status, unchanged', () => {
    expect(installTargetBadgeStatus({ status: 'done', error: null })).toBe('done');
    expect(installTargetBadgeStatus({ status: 'error', error: 'boom' })).toBe('error');
    expect(installTargetBadgeStatus({ status: 'installing' })).toBe('installing');
  });
});
