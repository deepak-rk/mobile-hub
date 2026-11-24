import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * One agent per machine id on a host. Two agents with the same id would both
 * heartbeat as that host and both claim its installs and device jobs, and
 * nothing stopped a second one from starting. The guard is keyed on the
 * identity, never on a port: a reference farm's port-based guard fell back to
 * another port and let two agents at different commits fight (lesson 40).
 *
 * A lock file per machine id holds the owner's pid. A file whose pid is no
 * longer running is stale (a crash, a kill) and is taken over.
 */
export class AgentAlreadyRunningError extends Error {}

export interface InstanceLock {
  file: string;
  release(): void;
}

const DEFAULT_DIR = path.join(os.homedir(), '.mobile-hub-agent');

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, it just isn't ours to signal.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function lockFile(dir: string, machineId: string): string {
  return path.join(dir, `agent-${machineId.replace(/[^A-Za-z0-9._-]/g, '_')}.lock`);
}

export function acquireInstanceLock(machineId: string, dir = DEFAULT_DIR, pid = process.pid): InstanceLock {
  fs.mkdirSync(dir, { recursive: true });
  const file = lockFile(dir, machineId);
  const body = JSON.stringify({ pid, machineId, startedAt: new Date().toISOString() });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, body, { flag: 'wx' });
      return {
        file,
        release() {
          // Only our own: a lock taken over after this one went stale is not ours to delete.
          try {
            if ((JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: number }).pid === pid) fs.unlinkSync(file);
          } catch {
            /* already gone */
          }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }

    let holder: { pid?: number; startedAt?: string } = {};
    try {
      holder = JSON.parse(fs.readFileSync(file, 'utf8')) as typeof holder;
    } catch {
      // Unreadable (half-written by a starting agent, or corrupt): not proof
      // that nobody holds it. Refuse rather than guess.
      throw new AgentAlreadyRunningError(
        `The agent lock ${file} exists but cannot be read. If no agent for '${machineId}' is running, delete it.`,
      );
    }
    if (holder.pid && holder.pid !== pid && isRunning(holder.pid)) {
      throw new AgentAlreadyRunningError(
        `An agent for machine id '${machineId}' is already running (pid ${holder.pid}, since ${holder.startedAt ?? 'unknown'}). ` +
          `Stop it first, or give this one a different MACHINE_ID. If no such agent is running, delete ${file}.`,
      );
    }
    fs.rmSync(file, { force: true }); // stale: its owner is gone
  }
  throw new AgentAlreadyRunningError(`Could not take the agent lock ${file}; another agent may be starting.`);
}
