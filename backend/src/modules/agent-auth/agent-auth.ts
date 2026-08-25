import { FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'crypto';
import { env } from '../../config/env';

/**
 * Agents are machines, not people: they have no user account, no session and
 * no role, so they authenticate with a shared secret rather than a JWT.
 *
 * `AGENT_TOKEN` is required in production — the server refuses to boot without
 * it (see server.ts). It stays optional in development so local work is
 * frictionless, but startup says loudly when the endpoints are open. The one
 * thing that must never happen is a deployment that is silently
 * unauthenticated.
 */
export function agentTokenIsConfigured(): boolean {
  return Boolean(env.AGENT_TOKEN);
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  // timingSafeEqual throws on a length mismatch, and the throw itself would
  // leak length, so compare lengths first and only then run the constant-time
  // comparison.
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Guards the two endpoints an agent posts to. Without it, anyone who can reach
 * the API can register phantom hosts and devices — or claim an existing
 * machineId, report zero devices, and thereby mark a real lab's devices
 * offline and release their locks, which is a trivial denial of service.
 */
// Must be async (i.e. return a Promise). Fastify decides how to run a hook by
// its arity: with two parameters it expects a Promise back, and a plain `void`
// return means it neither resolves nor gets a `done()` call — so every
// *authorised* request would hang forever while rejections still worked,
// because sending a reply ends the request on its own.
export async function requireAgentToken(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!env.AGENT_TOKEN) return; // dev-only open mode; warned about at startup

  const header = req.headers.authorization;
  const provided = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;

  if (!provided || !safeEqual(provided, env.AGENT_TOKEN)) {
    await reply.status(401).send({
      code: 'AGENT_UNAUTHORIZED',
      message: 'A valid agent token is required. Set AGENT_TOKEN on the agent to match the hub.',
    });
  }
}
