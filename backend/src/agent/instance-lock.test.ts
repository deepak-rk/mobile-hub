import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { acquireInstanceLock, AgentAlreadyRunningError } from './instance-lock';

describe('acquireInstanceLock', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-lock-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  // A pid that was running and has exited: a child that ran to completion.
  const deadPid = (): number => spawnSync(process.execPath, ['-e', '0']).pid;

  it('refuses a second agent for the same machine id while the first runs', () => {
    acquireInstanceLock('host-a', dir, process.pid);
    // A different pid claiming the same identity, while ours is alive.
    expect(() => acquireInstanceLock('host-a', dir, process.pid + 1)).toThrow(AgentAlreadyRunningError);
  });

  it('allows a different machine id on the same host', () => {
    acquireInstanceLock('host-a', dir);
    expect(() => acquireInstanceLock('host-b', dir)).not.toThrow();
  });

  it('takes over a lock whose agent is gone', () => {
    const stalePid = deadPid();
    fs.writeFileSync(path.join(dir, 'agent-host-a.lock'), JSON.stringify({ pid: stalePid }));
    const lock = acquireInstanceLock('host-a', dir);
    expect(JSON.parse(fs.readFileSync(lock.file, 'utf8'))).toMatchObject({ pid: process.pid });
  });

  it('refuses rather than guesses when the lock cannot be read', () => {
    fs.writeFileSync(path.join(dir, 'agent-host-a.lock'), '{"pid": 12');
    expect(() => acquireInstanceLock('host-a', dir)).toThrow(/cannot be read/);
  });

  it('release removes only its own lock', () => {
    const mine = acquireInstanceLock('host-a', dir);
    mine.release();
    expect(fs.existsSync(mine.file)).toBe(false);

    const old = acquireInstanceLock('host-a', dir, deadPid());
    const taken = acquireInstanceLock('host-a', dir); // took over the stale one
    old.release(); // the old owner's late cleanup
    expect(fs.existsSync(taken.file)).toBe(true);
  });

  it('keeps an odd machine id inside the lock directory', () => {
    // Unsanitised, `agent-/../../evil.lock` would resolve outside `dir`.
    const lock = acquireInstanceLock('/../../evil', dir);
    expect(path.dirname(lock.file)).toBe(dir);
  });
});
