import type { HostAgentCredential } from '../types';

/**
 * Picks the credential to surface for a host: the active one if it has one,
 * otherwise its most recent (the list arrives sorted `createdAt` desc, same
 * order the agent-credentials page renders it in). `undefined` means "don't
 * know yet" (still loading, or never fetched because the viewer isn't an
 * admin) — distinct from `null`, which means "fetched, and there truly is no
 * dedicated credential for this machineId" (the agent falls back to the
 * shared `AGENT_TOKEN`).
 */
export function credentialFor(
  credentials: HostAgentCredential[] | undefined,
  machineId: string,
): HostAgentCredential | null | undefined {
  if (!credentials) return undefined;
  const matches = credentials.filter((c) => c.machineId === machineId);
  if (matches.length === 0) return null;
  return matches.find((c) => !c.revokedAt) ?? matches[0];
}
