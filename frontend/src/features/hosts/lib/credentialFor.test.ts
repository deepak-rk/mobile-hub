import { describe, it, expect } from 'vitest';
import { credentialFor } from './credentialFor';
import type { HostAgentCredential } from '../types';

function credential(overrides: Partial<HostAgentCredential>): HostAgentCredential {
  return {
    id: overrides.id ?? 'id',
    machineId: 'host-1',
    revokedAt: null,
    createdAt: '2026-08-20T00:00:00.000Z',
    ...overrides,
  };
}

describe('credentialFor', () => {
  it('returns undefined when the credential list has not loaded yet (distinct from "none exist")', () => {
    expect(credentialFor(undefined, 'host-1')).toBeUndefined();
  });

  it('returns null when the list has loaded and this host has no dedicated credential', () => {
    expect(credentialFor([credential({ machineId: 'other-host' })], 'host-1')).toBeNull();
  });

  it('returns the single matching credential', () => {
    const cred = credential({ machineId: 'host-1' });
    expect(credentialFor([cred], 'host-1')).toBe(cred);
  });

  it('prefers the active credential over a revoked one for the same host', () => {
    const revoked = credential({ id: 'old', machineId: 'host-1', revokedAt: '2026-08-21T00:00:00.000Z' });
    const active = credential({ id: 'new', machineId: 'host-1', revokedAt: null });
    expect(credentialFor([revoked, active], 'host-1')).toBe(active);
  });

  it('falls back to the most recent (first in list) credential when all are revoked', () => {
    const first = credential({ id: 'first', machineId: 'host-1', revokedAt: '2026-08-21T00:00:00.000Z' });
    const second = credential({ id: 'second', machineId: 'host-1', revokedAt: '2026-08-22T00:00:00.000Z' });
    expect(credentialFor([first, second], 'host-1')).toBe(first);
  });

  it('ignores credentials belonging to other machines', () => {
    const mine = credential({ id: 'mine', machineId: 'host-1' });
    const theirs = credential({ id: 'theirs', machineId: 'host-2' });
    expect(credentialFor([theirs, mine], 'host-1')).toBe(mine);
  });
});
