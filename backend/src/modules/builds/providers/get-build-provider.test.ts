import { describe, it, expect } from 'vitest';
import { getBuildProvider } from './get-build-provider';
import { UrlBuildProvider } from './url-build-provider';
import { UnimplementedBuildProvider } from './unimplemented-build-provider';

describe('getBuildProvider', () => {
  it('returns the real url provider for "url"', () => {
    expect(getBuildProvider('url')).toBeInstanceOf(UrlBuildProvider);
  });

  it.each(['nexus', 's3', 'webhook'] as const)('returns a stub for "%s" that rejects rather than crashing', async (name) => {
    const provider = getBuildProvider(name);
    expect(provider).toBeInstanceOf(UnimplementedBuildProvider);
    expect(provider.name).toBe(name);
    await expect(
      provider.fetch({ project: 'p', platform: 'android', version: '1' }, '/tmp/x'),
    ).rejects.toThrow(/not implemented/i);
  });
});
