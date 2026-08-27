import { Schema, model, Document } from 'mongoose';

export interface IAgentCredential extends Document {
  machineId: string;
  /**
   * Public half of the token, stored in the clear so verification is an
   * indexed lookup rather than hashing the presented secret against every
   * active credential. Format: `mha_<12 random hex chars>`.
   */
  tokenId: string;
  /** SHA-256 hex digest of the secret half. See agent-credentials.service.ts for why SHA-256, not argon2. */
  secretHash: string;
  label?: string;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const agentCredentialSchema = new Schema<IAgentCredential>(
  {
    machineId: { type: String, required: true, index: true },
    tokenId: { type: String, required: true, unique: true, index: true },
    secretHash: { type: String, required: true },
    label: { type: String },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export const AgentCredential = model<IAgentCredential>('AgentCredential', agentCredentialSchema);
