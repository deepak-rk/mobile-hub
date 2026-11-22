import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { env } from '../../config/env';
import { isSuccess, RunOutcome } from '../../common/process-supervisor';

/**
 * One bare clone per automation repo, and a git worktree per run.
 *
 * Every run used to `git clone` the whole repo into its own workspace: the
 * full network transfer every time, and N concurrent runs of one repo meant N
 * clones. A reference farm in this domain moved to a shared bare repo plus a
 * worktree per run; this is that shape. The bare repo lives beside the run
 * cache (`EXECUTIONS_DIR/.repos`), not in any run's workspace, since it
 * outlives every run.
 *
 * All git work on one bare repo is serialized: a fetch and a `worktree add`
 * both write inside it, and git answers a concurrent writer with a lock error
 * rather than waiting.
 */

/** Runs one command for the caller, so its output reaches the run log and a cancel reaches the process. */
export type GitExec = (command: { command: string; args: string[] }, cwd: string) => Promise<RunOutcome>;

export function bareRepoDir(repoUrl: string): string {
  const id = crypto.createHash('sha256').update(repoUrl).digest('hex').slice(0, 32);
  return path.join(env.EXECUTIONS_DIR, '.repos', `${id}.git`);
}

const repoLocks = new Map<string, Promise<void>>();

async function withRepoLock<T>(dir: string, work: () => Promise<T>): Promise<T> {
  const previous = repoLocks.get(dir) ?? Promise.resolve();
  let release!: () => void;
  const mine = previous.then(() => new Promise<void>((resolve) => (release = resolve)));
  repoLocks.set(dir, mine);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (repoLocks.get(dir) === mine) repoLocks.delete(dir);
  }
}

/**
 * Puts `branch` of `repoUrl` at `worktreeDir` as a detached worktree.
 *
 * Returns the outcome of the first git step that failed, or the last one, so
 * the caller records it like any other stage command. `branch` must already
 * have passed `branchRefSchema`: it is embedded in a refspec.
 */
export async function checkoutWorktree(
  repoUrl: string,
  branch: string,
  worktreeDir: string,
  exec: GitExec,
): Promise<RunOutcome> {
  const bare = bareRepoDir(repoUrl);
  return withRepoLock(bare, async () => {
    fs.mkdirSync(path.dirname(bare), { recursive: true });
    if (!fs.existsSync(path.join(bare, 'HEAD'))) {
      // Half a bare repo from a killed clone is worse than none.
      fs.rmSync(bare, { recursive: true, force: true });
      const cloned = await exec({ command: 'git', args: ['clone', '--bare', '--', repoUrl, bare] }, path.dirname(bare));
      if (!isSuccess(cloned)) {
        fs.rmSync(bare, { recursive: true, force: true });
        return cloned;
      }
    }
    // Only the run's branch, forced: a force-pushed branch must win over the
    // old copy, since the run executes whatever the remote has now.
    const fetched = await exec(
      { command: 'git', args: ['-C', bare, 'fetch', '--prune', 'origin', `+refs/heads/${branch}:refs/heads/${branch}`] },
      bare,
    );
    if (!isSuccess(fetched)) return fetched;
    // Drops entries for worktrees whose workspace a finished run deleted.
    await exec({ command: 'git', args: ['-C', bare, 'worktree', 'prune'] }, bare);
    return exec(
      { command: 'git', args: ['-C', bare, 'worktree', 'add', '--detach', worktreeDir, `refs/heads/${branch}`] },
      bare,
    );
  });
}

/**
 * Boot-time cleanup of the shared repos: stale `*.lock` files a killed git
 * left behind (which make every later fetch fail), then a worktree prune.
 *
 * Only safe at boot, before any run starts: a lock file is stale exactly when
 * no git process from this hub can be holding it. Returns the number of lock
 * files removed.
 */
export async function cleanupSharedRepos(exec: GitExec): Promise<number> {
  const root = path.join(env.EXECUTIONS_DIR, '.repos');
  let removed = 0;
  let repos: string[];
  try {
    repos = fs.readdirSync(root).filter((n) => n.endsWith('.git'));
  } catch {
    return 0;
  }
  for (const name of repos) {
    const bare = path.join(root, name);
    removed += removeLockFiles(bare);
    await exec({ command: 'git', args: ['-C', bare, 'worktree', 'prune'] }, bare);
  }
  return removed;
}

function removeLockFiles(dir: string): number {
  let removed = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Pack data is large and never holds lock files worth scanning.
      if (entry.name !== 'objects') removed += removeLockFiles(full);
    } else if (entry.name.endsWith('.lock')) {
      fs.rmSync(full, { force: true });
      removed += 1;
    }
  }
  return removed;
}
