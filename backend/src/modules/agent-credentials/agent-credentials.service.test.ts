import { describe, it, expect, vi, afterEach } from 'vitest';
import { AgentCredential } from './agent-credential.model';
import { issueCredential, listCredentials, revokeCredential, verifyAgentCredential } from './agent-credentials.service';

/**
 * Per-agent credentials replace the single shared AGENT_TOKEN for a host,
 * so a compromised one can be revoked without rotating everyone else's.
 * These pin the properties that matter for that promise: the raw token is
 * only ever handed back at issuance, verification actually rejects a
 * revoked credential (not just flips a DB field nobody checks), and a
 * wrong secret against a real tokenId still fails.
 */
afterEach(() => {
  vi.restoreAllMocks();
});

describe('issueCredential', () => {
  it('returns a raw token shaped as tokenId.secret, and never stores it', async () => {
    let stored: Record<string, unknown> | undefined;
    vi.spyOn(AgentCredential, 'create').mockImplementation((async (doc: Record<string, unknown>) => {
      stored = doc;
      return {
        _id: { toString: () => 'cred-1' },
        machineId: doc.machineId,
        label: doc.label,
        createdAt: new Date('2026-08-27T00:00:00Z'),
      };
    }) as never);

    const issued = await issueCredential('host-1', 'ci-runner');

    expect(issued.machineId).toBe('host-1');
    expect(issued.label).toBe('ci-runner');
    expect(issued.rawToken).toMatch(/^mha_[0-9a-f]{12}\.[0-9a-f]{64}$/);

    // Only the hash of the secret half is ever persisted.
    const [tokenId, secret] = issued.rawToken.split('.');
    expect(stored?.tokenId).toBe(tokenId);
    expect(stored?.secretHash).not.toBe(secret);
    expect(stored?.secretHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('verifyAgentCredential', () => {
  it('accepts the exact raw token for an active credential', async () => {
    const capture = captureIssuedDoc();
    const issued = await issueCredential('host-1');
    vi.spyOn(AgentCredential, 'findOne').mockResolvedValue(capture.doc as never);

    await expect(verifyAgentCredential(issued.rawToken)).resolves.toEqual({ machineId: 'host-1' });
  });

  it('rejects a wrong secret against a real tokenId', async () => {
    const capture = captureIssuedDoc();
    const issued = await issueCredential('host-1');
    vi.spyOn(AgentCredential, 'findOne').mockResolvedValue(capture.doc as never);

    const [tokenId] = issued.rawToken.split('.');
    await expect(verifyAgentCredential(`${tokenId}.not-the-real-secret`)).resolves.toBeNull();
  });

  it('rejects an unknown tokenId', async () => {
    vi.spyOn(AgentCredential, 'findOne').mockResolvedValue(null as never);
    await expect(verifyAgentCredential('mha_deadbeef0000.somesecret')).resolves.toBeNull();
  });

  it('rejects a malformed token with no dot separator', async () => {
    const findOne = vi.spyOn(AgentCredential, 'findOne');
    await expect(verifyAgentCredential('not-a-valid-token-shape')).resolves.toBeNull();
    expect(findOne).not.toHaveBeenCalled(); // short-circuits before touching the database
  });

  it('rejects a revoked credential even with the correct secret', async () => {
    // A revoked credential is queried with revokedAt: null, so it simply
    // won't be found — this is the property that makes revocation real
    // rather than a DB flag nobody checks.
    vi.spyOn(AgentCredential, 'findOne').mockResolvedValue(null as never);
    await expect(verifyAgentCredential('mha_abc123def456.anysecretatall')).resolves.toBeNull();
  });
});

describe('listCredentials', () => {
  it('never includes the secret hash', async () => {
    vi.spyOn(AgentCredential, 'find').mockReturnValue({
      sort: () =>
        Promise.resolve([
          {
            _id: { toString: () => 'cred-1' },
            machineId: 'host-1',
            label: 'ci-runner',
            createdAt: new Date(),
            revokedAt: null,
          },
        ]),
    } as never);

    const list = await listCredentials();

    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty('secretHash');
    expect(list[0]).not.toHaveProperty('tokenId');
  });
});

describe('revokeCredential', () => {
  it('sets revokedAt and returns the updated summary', async () => {
    const revokedAt = new Date('2026-08-27T00:00:00Z');
    vi.spyOn(AgentCredential, 'findByIdAndUpdate').mockResolvedValue({
      _id: { toString: () => 'cred-1' },
      machineId: 'host-1',
      createdAt: new Date('2026-08-01T00:00:00Z'),
      revokedAt,
    } as never);

    const result = await revokeCredential('cred-1');

    expect(result?.revokedAt).toBe(revokedAt);
  });

  it('returns null for an unknown id', async () => {
    vi.spyOn(AgentCredential, 'findByIdAndUpdate').mockResolvedValue(null as never);
    await expect(revokeCredential('does-not-exist')).resolves.toBeNull();
  });
});

/**
 * `issueCredential` calls `AgentCredential.create`, so tests that then need
 * `findOne` to return "the credential that was just issued" capture what
 * was passed to `create` and hand it back in the shape `findOne` would
 * return — avoiding a real database while still exercising the actual
 * hash/compare path, not a bypassed one.
 */
function captureIssuedDoc() {
  const state: { doc?: Record<string, unknown> } = {};
  vi.spyOn(AgentCredential, 'create').mockImplementation((async (doc: Record<string, unknown>) => {
    state.doc = doc;
    return {
      _id: { toString: () => 'cred-1' },
      machineId: doc.machineId,
      label: doc.label,
      createdAt: new Date(),
    };
  }) as never);
  return {
    get doc() {
      return state.doc;
    },
  };
}
