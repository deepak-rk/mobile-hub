import { describe, it, expect } from 'vitest';
import { buildProgress } from './buildProgress';

/** Regression: the download bar was hardcoded to 45% whatever had actually been fetched. */
describe('buildProgress', () => {
  it('reports the real byte ratio while downloading with a known size', () => {
    const p = buildProgress({ status: 'downloading', sizeBytes: 200, downloadedBytes: 50 });
    expect(p?.value).toBe(25);
  });

  it('shows no percentage at all when the total size is unknown', () => {
    expect(buildProgress({ status: 'downloading', sizeBytes: null, downloadedBytes: 50 })?.value).toBeNull();
    expect(buildProgress({ status: 'downloading', sizeBytes: null })?.value).toBeNull();
  });

  it('has no bar once the build is settled', () => {
    expect(buildProgress({ status: 'ready', sizeBytes: 200, downloadedBytes: 200 })).toBeNull();
  });
});
