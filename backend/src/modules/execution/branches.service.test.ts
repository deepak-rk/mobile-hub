import { describe, it, expect, vi, afterEach } from 'vitest';
import * as supervisor from '../../common/process-supervisor';
import { discoverBranches, parseDefaultBranch, parseLsRemoteHeads, BranchDiscoveryError } from './branches.service';

describe('parseDefaultBranch', () => {
  it('reads the HEAD symref line, including slashes in the name', () => {
    expect(parseDefaultBranch('ref: refs/heads/release/2.x\tHEAD\nabc\tHEAD\n')).toBe('release/2.x');
  });

  it('returns null when the remote does not report HEAD', () => {
    expect(parseDefaultBranch('abc\trefs/heads/main\n')).toBeNull();
  });
});

describe('parseLsRemoteHeads', () => {
  it('extracts branch names from real git ls-remote --heads output', () => {
    const stdout =
      'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2\trefs/heads/main\n' +
      'b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3\trefs/heads/feature/login\n';

    expect(parseLsRemoteHeads(stdout)).toEqual(['feature/login', 'main']);
  });

  it('ignores tags and other non-branch refs', () => {
    const stdout =
      'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2\trefs/heads/main\n' +
      'c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4\trefs/tags/v1.0.0\n';

    expect(parseLsRemoteHeads(stdout)).toEqual(['main']);
  });

  it('returns an empty list for a repo with no branches', () => {
    expect(parseLsRemoteHeads('')).toEqual([]);
  });

  it('sorts alphabetically for a stable dropdown order', () => {
    const stdout =
      'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2\trefs/heads/zeta\n' +
      'b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3\trefs/heads/alpha\n';

    expect(parseLsRemoteHeads(stdout)).toEqual(['alpha', 'zeta']);
  });
});

describe('discoverBranches', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockGitOutput(stdout: string, ok = true) {
    vi.spyOn(supervisor, 'run').mockImplementation((opts) => {
      opts.onStdout?.(Buffer.from(stdout));
      return {
        result: Promise.resolve(ok ? { kind: 'exited', exitCode: 0 } : { kind: 'exited', exitCode: 128 }),
        pid: 1234,
        cancel: () => {},
      };
    });
  }

  it('returns real branch names on success', async () => {
    mockGitOutput('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2\trefs/heads/main\n');

    expect(await discoverBranches('https://example.com/repo.git')).toEqual({ branches: ['main'], defaultBranch: null });
  });

  it('reports the remote default branch from --symref output', async () => {
    const sha = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
    mockGitOutput(`ref: refs/heads/develop\tHEAD\n${sha}\tHEAD\n${sha}\trefs/heads/develop\n${sha}\trefs/heads/main\n`);

    expect(await discoverBranches('https://example.com/develop-default.git')).toEqual({
      branches: ['develop', 'main'],
      defaultBranch: 'develop',
    });
  });

  it('throws BranchDiscoveryError when git exits non-zero', async () => {
    mockGitOutput('fatal: repository not found\n', false);

    await expect(discoverBranches('https://example.com/gone.git')).rejects.toThrow(BranchDiscoveryError);
  });

  it('caches the result and does not re-run git within the TTL', async () => {
    const run = vi.spyOn(supervisor, 'run').mockImplementation((opts) => {
      opts.onStdout?.(Buffer.from('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2\trefs/heads/main\n'));
      return { result: Promise.resolve({ kind: 'exited', exitCode: 0 }), pid: 1234, cancel: () => {} };
    });

    await discoverBranches('https://example.com/cached.git');
    await discoverBranches('https://example.com/cached.git');

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('bypasses the cache when refresh is requested', async () => {
    const run = vi.spyOn(supervisor, 'run').mockImplementation((opts) => {
      opts.onStdout?.(Buffer.from('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2\trefs/heads/main\n'));
      return { result: Promise.resolve({ kind: 'exited', exitCode: 0 }), pid: 1234, cancel: () => {} };
    });

    await discoverBranches('https://example.com/refreshed.git');
    await discoverBranches('https://example.com/refreshed.git', { refresh: true });

    expect(run).toHaveBeenCalledTimes(2);
  });
});
