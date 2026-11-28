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
  /** Set when an admin removed the host from the lab; its agent is refused until unblocked. Absent on older hubs. */
  blocked?: { at: string; by: string; reason: string | null } | null;
  /** The last time the hub refused another machine using this machine id (cleared after 5 min). Absent on older hubs. */
  idConflict?: { at: string; hostname: string | null } | null;
  lastHeartbeatAt: string;
  /** Best-effort — absent for an agent that predates this field, or any one field null if that agent's own probe failed. */
  diagnostics: {
    diskFreeBytes: number | null;
    diskTotalBytes: number | null;
    nodeVersion: string | null;
    /** Busy % over the last heartbeat interval; null until two samples exist. Absent on older hubs. */
    cpuPercent?: number | null;
    cpuCount?: number | null;
    memTotalBytes?: number | null;
    memFreeBytes?: number | null;
  } | null;
  /** The agent's hub <-> agent contract version; null for an agent that predates it. Absent on older hubs. */
  protocolVersion?: number | null;
  /** The hub's own contract version, sent with the list. Absent on older hubs. */
  hubProtocolVersion?: number;
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
