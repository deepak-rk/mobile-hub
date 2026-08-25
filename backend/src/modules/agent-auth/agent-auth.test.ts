import { describe, it, expect, vi, afterEach } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';

const TOKEN = 'a-sufficiently-long-agent-token';

/**
 * Without this guard anyone who can reach the API can register phantom hosts
 * and devices — or claim an existing machineId, report zero devices, and so
 * mark a real lab's devices offline and release their locks. That is a
 * one-request denial of service against a whole lab.
 */
async function loadWithToken(token?: string) {
  vi.resetModules();
  vi.doMock('../../config/env', () => ({ env: { AGENT_TOKEN: token, NODE_ENV: 'test' } }));
  return import('./agent-auth');
}

function fakeReply() {
  const reply = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      reply.statusCode = code;
      return reply;
    },
    send(payload: unknown) {
      reply.body = payload;
      return reply;
    },
  };
  return reply as unknown as FastifyReply & { statusCode: number; body: { code?: string } };
}

const reqWith = (auth?: string) => ({ headers: auth ? { authorization: auth } : {} }) as FastifyRequest;

afterEach(() => {
  vi.doUnmock('../../config/env');
  vi.resetModules();
});

describe('requireAgentToken', () => {
  it('accepts a request carrying the exact token', async () => {
    const { requireAgentToken } = await loadWithToken(TOKEN);
    const reply = fakeReply();

    await requireAgentToken(reqWith(`Bearer ${TOKEN}`), reply);

    expect(reply.statusCode).toBe(0); // never touched → allowed through
  });

  it('rejects a request with no Authorization header', async () => {
    const { requireAgentToken } = await loadWithToken(TOKEN);
    const reply = fakeReply();

    await requireAgentToken(reqWith(), reply);

    expect(reply.statusCode).toBe(401);
    expect(reply.body.code).toBe('AGENT_UNAUTHORIZED');
  });

  it('rejects a wrong token', async () => {
    const { requireAgentToken } = await loadWithToken(TOKEN);
    const reply = fakeReply();

    await requireAgentToken(reqWith('Bearer not-the-right-token-at-all'), reply);

    expect(reply.statusCode).toBe(401);
  });

  it('rejects a token of a different length without throwing', async () => {
    // timingSafeEqual throws on length mismatch; the guard must compare
    // lengths first rather than letting that become a 500.
    const { requireAgentToken } = await loadWithToken(TOKEN);
    const reply = fakeReply();

    await expect(requireAgentToken(reqWith('Bearer short'), reply)).resolves.toBeUndefined();
    expect(reply.statusCode).toBe(401);
  });

  it('rejects a correct token sent without the Bearer scheme', async () => {
    const { requireAgentToken } = await loadWithToken(TOKEN);
    const reply = fakeReply();

    await requireAgentToken(reqWith(TOKEN), reply);

    expect(reply.statusCode).toBe(401);
  });

  it('resolves (rather than hanging) on the authorised path — Fastify awaits this hook', async () => {
    // A void-returning 2-arity hook makes Fastify wait forever: it gets no
    // promise and no done() call, so authorised requests hang while
    // rejections still work. Pin that this resolves.
    const { requireAgentToken } = await loadWithToken(TOKEN);
    await expect(requireAgentToken(reqWith(`Bearer ${TOKEN}`), fakeReply())).resolves.toBeUndefined();
  });

  it('allows everything through when no token is configured (dev-only open mode)', async () => {
    const { requireAgentToken, agentTokenIsConfigured } = await loadWithToken(undefined);
    const reply = fakeReply();

    await requireAgentToken(reqWith(), reply);

    expect(reply.statusCode).toBe(0);
    // Startup relies on this to decide whether to warn, or refuse to boot in production.
    expect(agentTokenIsConfigured()).toBe(false);
  });

  it('reports a configured token so startup can skip the warning', async () => {
    const { agentTokenIsConfigured } = await loadWithToken(TOKEN);
    expect(agentTokenIsConfigured()).toBe(true);
  });
});
