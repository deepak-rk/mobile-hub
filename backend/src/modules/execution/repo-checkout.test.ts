import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { env } from '../../config/env';
import { RunOutcome } from '../../common/process-supervisor';
import { bareRepoDir, checkoutWorktree, cleanupSharedRepos, GitExec } from './repo-checkout';

/**
 * Real git against a local origin repo: the point of this module is how git
 * behaves (bare clone, refspec fetch, worktrees, lock files), which a mocked
 * git would only restate.
 */
describe('shared bare repo + worktree per run', () => {
  let tmp: string;
  let origin: string;
  let origDir: string;
  let calls: string[][];

  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();

  const exec: GitExec = async (cmd, cwd) => {
    calls.push(cmd.args);
    try {
      execFileSync(cmd.command, cmd.args, { cwd, stdio: 'pipe' });
      return { kind: 'exited', exitCode: 0 } as RunOutcome;
    } catch (err) {
      return { kind: 'exited', exitCode: (err as { status?: number }).status ?? 1 } as RunOutcome;
    }
  };

  function commit(file: string, content: string) {
    fs.writeFileSync(path.join(origin, file), content);
    git(origin, 'add', '-A');
    git(origin, '-c', 'user.email=t@example.test', '-c', 'user.name=T', 'commit', '-qm', file);
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-worktree-'));
    origDir = env.EXECUTIONS_DIR;
    env.EXECUTIONS_DIR = path.join(tmp, 'executions');
    origin = path.join(tmp, 'origin');
    fs.mkdirSync(origin);
    git(origin, 'init', '-q', '-b', 'main');
    commit('a.txt', 'one');
    calls = [];
  });

  afterEach(() => {
    env.EXECUTIONS_DIR = origDir;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const workspace = (name: string) => path.join(env.EXECUTIONS_DIR, name, 'repo');

  it('clones once, then each run gets its own worktree of the current branch tip', async () => {
    expect((await checkoutWorktree(origin, 'main', workspace('r1'), exec)).kind).toBe('exited');
    expect(fs.readFileSync(path.join(workspace('r1'), 'a.txt'), 'utf8')).toBe('one');

    commit('b.txt', 'two');
    await checkoutWorktree(origin, 'main', workspace('r2'), exec);

    // The second run sees the new commit (fetched), without a second clone.
    expect(fs.existsSync(path.join(workspace('r2'), 'b.txt'))).toBe(true);
    expect(calls.filter((a) => a[0] === 'clone')).toHaveLength(1);
    expect(git(workspace('r2'), 'rev-parse', 'HEAD')).toBe(git(origin, 'rev-parse', 'HEAD'));
  });

  it('serializes concurrent checkouts of one repo instead of failing on git locks', async () => {
    const outcomes = await Promise.all(
      ['c1', 'c2', 'c3'].map((n) => checkoutWorktree(origin, 'main', workspace(n), exec)),
    );
    expect(outcomes.every((o) => o.kind === 'exited' && o.exitCode === 0)).toBe(true);
    for (const n of ['c1', 'c2', 'c3']) expect(fs.existsSync(path.join(workspace(n), 'a.txt'))).toBe(true);
  });

  it('reports an unknown branch as a failed step, leaving the shared repo usable', async () => {
    const outcome = await checkoutWorktree(origin, 'no-such-branch', workspace('x'), exec);
    expect(outcome).toMatchObject({ kind: 'exited' });
    expect((outcome as { exitCode: number }).exitCode).not.toBe(0);
    expect((await checkoutWorktree(origin, 'main', workspace('y'), exec)) as { exitCode: number }).toMatchObject({
      exitCode: 0,
    });
  });

  it('removes stale lock files at boot so the next fetch is not blocked', async () => {
    await checkoutWorktree(origin, 'main', workspace('r1'), exec);
    const bare = bareRepoDir(origin);
    fs.writeFileSync(path.join(bare, 'packed-refs.lock'), '');
    fs.writeFileSync(path.join(bare, 'refs', 'heads', 'main.lock'), '');

    expect(await cleanupSharedRepos(exec)).toBe(2);
    commit('c.txt', 'three');
    await checkoutWorktree(origin, 'main', workspace('r2'), exec);
    expect(fs.existsSync(path.join(workspace('r2'), 'c.txt'))).toBe(true);
  });
});
