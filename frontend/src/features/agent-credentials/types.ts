export interface AgentCredential {
  id: string;
  machineId: string;
  label?: string;
  createdAt: string;
  revokedAt: string | null;
}

/** Only ever present in the response of the issue mutation — never fetched or stored again. */
export interface IssuedAgentCredential extends AgentCredential {
  rawToken: string;
}
