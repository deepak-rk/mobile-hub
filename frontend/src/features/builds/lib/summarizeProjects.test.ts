import { describe, it, expect } from 'vitest';
import { summarizeProjects } from './summarizeProjects';
import type { Build } from '../types';

function build(overrides: Partial<Build>): Build {
  return {
    _id: overrides._id ?? 'build-id',
    project: 'checkout-app',
    platform: 'android',
    version: '1.0.0',
    artifactUrl: 'https://example.com/artifact.apk',
    artifactPath: '/builds/artifact.apk',
    sizeBytes: 1024,
    checksum: 'abc123',
    status: 'ready',
    integrityValidatedAt: '2026-08-20T00:00:00.000Z',
    fetchedAt: '2026-08-20T00:00:00.000Z',
    purgedAt: null,
    createdAt: '2026-08-20T00:00:00.000Z',
    ...overrides,
  };
}

describe('summarizeProjects', () => {
  it('returns nothing for an empty build list', () => {
    expect(summarizeProjects([])).toEqual([]);
  });

  it('groups builds by project', () => {
    const builds = [
      build({ _id: 'a', project: 'checkout-app' }),
      build({ _id: 'b', project: 'checkout-app' }),
      build({ _id: 'c', project: 'onboarding-app' }),
    ];

    const summaries = summarizeProjects(builds);

    expect(summaries).toHaveLength(2);
    expect(summaries.find((s) => s.project === 'checkout-app')?.buildCount).toBe(2);
    expect(summaries.find((s) => s.project === 'onboarding-app')?.buildCount).toBe(1);
  });

  it('sorts projects alphabetically', () => {
    const builds = [build({ _id: 'a', project: 'zebra-app' }), build({ _id: 'b', project: 'alpha-app' })];
    expect(summarizeProjects(builds).map((s) => s.project)).toEqual(['alpha-app', 'zebra-app']);
  });

  it('picks the most recently created build as latest, not the highest version string', () => {
    const builds = [
      build({ _id: 'old', version: '9.0.0', createdAt: '2026-08-01T00:00:00.000Z' }),
      build({ _id: 'new', version: '1.0.0', createdAt: '2026-08-20T00:00:00.000Z' }),
    ];

    expect(summarizeProjects(builds)[0].latest._id).toBe('new');
  });

  it('counts on-disk (ready) and purged builds separately', () => {
    const builds = [
      build({ _id: 'a', status: 'ready' }),
      build({ _id: 'b', status: 'ready' }),
      build({ _id: 'c', status: 'purged' }),
      build({ _id: 'd', status: 'corrupt' }),
    ];

    const summary = summarizeProjects(builds)[0];
    expect(summary.buildCount).toBe(4);
    expect(summary.onDiskCount).toBe(2);
    expect(summary.purgedCount).toBe(1);
  });
});
