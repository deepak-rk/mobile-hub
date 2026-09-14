import * as fs from 'fs';
import * as path from 'path';
import { HostDiagnostics } from './hub-client';

/**
 * Best-effort host stats for the diagnostics panel — never throws. A host
 * where `statfs` isn't available (older Node, an unsupported platform) just
 * reports null disk numbers rather than taking the whole heartbeat down.
 */
export async function collectDiagnostics(): Promise<HostDiagnostics> {
  let diskFreeBytes: number | null = null;
  let diskTotalBytes: number | null = null;
  try {
    const stats = await fs.promises.statfs(path.parse(process.cwd()).root);
    diskFreeBytes = stats.bavail * stats.bsize;
    diskTotalBytes = stats.blocks * stats.bsize;
  } catch {
    // Left null — see doc comment above.
  }

  return { diskFreeBytes, diskTotalBytes, nodeVersion: process.version };
}
