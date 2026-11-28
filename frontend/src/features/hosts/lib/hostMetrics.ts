import { formatBytes } from 'ts-format-utils';
import type { Host } from '../types';

/** Memory in use, or null when the agent did not report both numbers (never shown as 0 %). */
export function memoryUse(diagnostics: NonNullable<Host['diagnostics']>): { usedPercent: number | null; label: string } {
  const total = diagnostics.memTotalBytes ?? null;
  const free = diagnostics.memFreeBytes ?? null;
  if (total === null || free === null || total <= 0) return { usedPercent: null, label: '' };
  const usedPercent = Math.min(100, Math.max(0, ((total - free) / total) * 100));
  return { usedPercent, label: `Memory ${formatBytes(free)} free of ${formatBytes(total)}` };
}

export type ProtocolState = 'match' | 'agent-older' | 'agent-newer' | 'unknown';

/** Unknown when either side did not say: an agent or hub that predates the field. */
export function protocolState(agent: number | null | undefined, hub: number | undefined): ProtocolState {
  if (agent === null || agent === undefined || hub === undefined) return 'unknown';
  if (agent === hub) return 'match';
  return agent < hub ? 'agent-older' : 'agent-newer';
}
