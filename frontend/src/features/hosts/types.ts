export interface Host {
  _id: string;
  machineId: string;
  hostname: string;
  os: 'darwin' | 'linux' | 'win32';
  agentVersion: string;
  capabilities: {
    maxDevices: number;
    androidSupport: boolean;
    iosSupport: boolean;
  };
  status: 'online' | 'offline';
  lastHeartbeatAt: string;
  /** Best-effort — absent for an agent that predates this field, or any one field null if that agent's own probe failed. */
  diagnostics: {
    diskFreeBytes: number | null;
    diskTotalBytes: number | null;
    nodeVersion: string | null;
  } | null;
  /** Live counts on this host, composed by the hub at request time — not stored on the host document. */
  activity: {
    runs: number;
    streams: number;
    installs: number;
    uninstalls: number;
  };
}

/**
 * Redacted shape of `backend/src/modules/agent-credentials`'s `CredentialSummary`
 * — mirrors `frontend/src/features/agent-credentials/types.ts`'s `AgentCredential`
 * rather than importing it, so this feature doesn't reach across into another
 * one for a four-field shape. Admin-only on the backend, same as there.
 */
export interface HostAgentCredential {
  id: string;
  machineId: string;
  label?: string;
  createdAt: string;
  revokedAt: string | null;
}
