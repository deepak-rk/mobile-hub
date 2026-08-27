import { randomBytes, createHash, timingSafeEqual } from 'crypto';
import { AgentCredential, IAgentCredential } from './agent-credential.model';

const TOKEN_PREFIX = 'mha'; // "mobile-hub agent"
const SECRET_BYTES = 32; // 256 bits

export interface IssuedCredential {
  id: string;
  machineId: string;
  label?: string;
  createdAt: Date;
  /** Only ever available here, at issuance — never retrievable again. */
  rawToken: string;
}

export interface CredentialSummary {
  id: string;
  machineId: string;
  label?: string;
  createdAt: Date;
  revokedAt: Date | null;
}

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

function toSummary(doc: IAgentCredential): CredentialSummary {
  return {
    id: doc._id.toString(),
    machineId: doc.machineId,
    label: doc.label,
    createdAt: doc.createdAt,
    revokedAt: doc.revokedAt,
  };
}

/**
 * Mints a new per-agent credential, replacing the single shared AGENT_TOKEN
 * as the thing a specific host authenticates with — so a compromised host
 * can be revoked without rotating every other agent's secret.
 *
 * The raw token is `<tokenId>.<secret>`: `tokenId` is a public identifier
 * stored in the clear (an indexed lookup, not a table scan hashing the
 * presented secret against every active credential); `secret` is what
 * actually proves possession and is never stored — only its hash is.
 *
 * Hashed with plain SHA-256, not argon2 (unlike user passwords in
 * modules/auth/). Argon2's deliberate memory-hardness defends low-entropy,
 * human-chosen secrets against brute force. This secret is 256 bits of
 * `crypto.randomBytes` — already computationally infeasible to brute-force
 * regardless of hash function — so a slow KDF buys nothing here and would
 * add real CPU cost to every single agent request (a fleet of hosts
 * heartbeats every ~10s by default).
 */
export async function issueCredential(machineId: string, label?: string): Promise<IssuedCredential> {
  const tokenId = `${TOKEN_PREFIX}_${randomBytes(6).toString('hex')}`;
  const secret = randomBytes(SECRET_BYTES).toString('hex');

  const doc = await AgentCredential.create({
    machineId,
    tokenId,
    secretHash: hashSecret(secret),
    label,
  });

  return {
    id: doc._id.toString(),
    machineId: doc.machineId,
    label: doc.label,
    createdAt: doc.createdAt,
    rawToken: `${tokenId}.${secret}`,
  };
}

export async function listCredentials(): Promise<CredentialSummary[]> {
  const docs = await AgentCredential.find().sort({ createdAt: -1 });
  return docs.map(toSummary);
}

/** Returns the revoked credential's summary, or null if the id doesn't exist. */
export async function revokeCredential(id: string): Promise<CredentialSummary | null> {
  const doc = await AgentCredential.findByIdAndUpdate(id, { revokedAt: new Date() }, { new: true });
  return doc ? toSummary(doc) : null;
}

/**
 * Verifies a raw `<tokenId>.<secret>` token and returns the machineId it
 * belongs to, or null if it doesn't match an active credential (unknown
 * tokenId, wrong secret, or a revoked one — all indistinguishable to the
 * caller, same as any other auth failure).
 */
export async function verifyAgentCredential(rawToken: string): Promise<{ machineId: string } | null> {
  const dot = rawToken.indexOf('.');
  if (dot <= 0) return null;

  const tokenId = rawToken.slice(0, dot);
  const secret = rawToken.slice(dot + 1);
  if (!secret) return null;

  const doc = await AgentCredential.findOne({ tokenId, revokedAt: null });
  if (!doc) return null;

  const provided = Buffer.from(hashSecret(secret));
  const expected = Buffer.from(doc.secretHash);
  // Both are fixed-length hex SHA-256 digests, so lengths always match —
  // no length-leak risk the way a variable-length raw compare would have.
  if (!timingSafeEqual(provided, expected)) return null;

  return { machineId: doc.machineId };
}
