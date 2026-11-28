import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_DIR = path.join(os.homedir(), '.mobile-hub-agent');
const ID_FILE = 'machine-id';
const VALID_ID = /^[^\s/\\][^\r\n]{0,199}$/;

export interface ResolvedMachineId {
  id: string;
  /** env: MACHINE_ID was set. file: read from the persisted file. new: first start, just persisted. unsaved: could not persist. */
  source: 'env' | 'file' | 'new' | 'unsaved';
}

/**
 * This host's id, the key every device, lock and install is filed under.
 *
 * MACHINE_ID wins when set. Otherwise the id is the one persisted on first
 * start, so renaming the machine later does not turn it into a new host and
 * orphan its devices. A first start persists the hostname: readable on the
 * Hosts page, and the same id an existing install already has, since the
 * hostname was the default before the id was persisted.
 */
export function resolveMachineId(
  envValue: string | undefined,
  dir = DEFAULT_DIR,
  hostname = os.hostname(),
): ResolvedMachineId {
  if (envValue && envValue.trim()) return { id: envValue.trim(), source: 'env' };
  const file = path.join(dir, ID_FILE);
  let saved: string | null = null;
  try {
    saved = fs.readFileSync(file, 'utf8').trim();
  } catch {
    // absent on a first start
  }
  if (saved && VALID_ID.test(saved)) return { id: saved, source: 'file' };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, `${hostname}\n`, { encoding: 'utf8', flag: saved === null ? 'wx' : 'w' });
    return { id: hostname, source: 'new' };
  } catch {
    return { id: hostname, source: 'unsaved' };
  }
}

/** The operating system's own id for this machine, or null when it cannot be read. */
export function readOsMachineId(platform: NodeJS.Platform = process.platform): string | null {
  try {
    if (platform === 'linux') {
      for (const f of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
        try {
          const v = fs.readFileSync(f, 'utf8').trim();
          if (v) return v;
        } catch {
          // try the next one
        }
      }
      return null;
    }
    if (platform === 'win32') {
      const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], {
        encoding: 'utf8',
        timeout: 5_000,
        windowsHide: true,
      });
      return parseWindowsMachineGuid(out);
    }
    if (platform === 'darwin') {
      const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8', timeout: 5_000 });
      return /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out)?.[1] ?? null;
    }
  } catch {
    // no permission, tool missing: no fingerprint, no duplicate detection
  }
  return null;
}

export function parseWindowsMachineGuid(regOutput: string): string | null {
  return /MachineGuid\s+REG_SZ\s+(\S+)/.exec(regOutput)?.[1] ?? null;
}

/**
 * A hash of the OS machine id, sent with agent traffic so the hub can tell
 * two machines claiming the same MACHINE_ID apart. Hashed so the raw OS id
 * never leaves the machine. Stable across agent restarts, unlike a per-process
 * value, which a quick restart would make look like a second host.
 */
export function machineFingerprint(osMachineId: string | null): string | null {
  if (!osMachineId) return null;
  return createHash('sha256').update(`mobile-hub:${osMachineId}`).digest('hex').slice(0, 32);
}
