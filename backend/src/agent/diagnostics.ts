import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HostDiagnostics } from './hub-client';

interface CpuTimes {
  idle: number;
  total: number;
}

function cpuTimes(cpus: os.CpuInfo[]): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const { times } of cpus) {
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
  }
  return { idle, total };
}

/**
 * CPU busy percentage between two calls. A single `os.cpus()` reading is the
 * average since boot, which on a long-running host barely moves however busy
 * it is now, so the first call returns null rather than that average.
 */
export function createCpuSampler(read: () => os.CpuInfo[] = os.cpus): () => number | null {
  let previous: CpuTimes | null = null;
  return () => {
    const cpus = read();
    if (cpus.length === 0) return null;
    const now = cpuTimes(cpus);
    const last = previous;
    previous = now;
    if (!last) return null;
    const total = now.total - last.total;
    if (total <= 0) return null;
    const busy = 1 - (now.idle - last.idle) / total;
    return Math.round(Math.min(1, Math.max(0, busy)) * 1000) / 10;
  };
}

/**
 * Best-effort host stats for the diagnostics panel — never throws. A host
 * where `statfs` isn't available (older Node, an unsupported platform) just
 * reports null disk numbers rather than taking the whole heartbeat down.
 */
export async function collectDiagnostics(sampleCpu: () => number | null = () => null): Promise<HostDiagnostics> {
  let diskFreeBytes: number | null = null;
  let diskTotalBytes: number | null = null;
  try {
    const stats = await fs.promises.statfs(path.parse(process.cwd()).root);
    diskFreeBytes = stats.bavail * stats.bsize;
    diskTotalBytes = stats.blocks * stats.bsize;
  } catch {
    // Left null — see doc comment above.
  }

  let cpuPercent: number | null = null;
  try {
    cpuPercent = sampleCpu();
  } catch {
    // Left null.
  }

  return {
    diskFreeBytes,
    diskTotalBytes,
    nodeVersion: process.version,
    cpuPercent,
    cpuCount: os.cpus().length || null,
    memTotalBytes: os.totalmem() || null,
    memFreeBytes: os.freemem() || null,
  };
}
