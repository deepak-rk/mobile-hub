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
