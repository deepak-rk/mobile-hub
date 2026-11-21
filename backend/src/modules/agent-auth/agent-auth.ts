import { FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'crypto';
import { env } from '../../config/env';
import { verifyAgentCredential } from '../agent-credentials/agent-credentials.service';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Set when the request authenticated via a per-agent credential — the
     * machineId that credential belongs to. `null` when it authenticated via
     * the legacy shared AGENT_TOKEN instead, which carries no specific
     * identity (any machineId is trusted, exactly as before per-agent
     * credentials existed), or when auth isn't configured at all (dev-only
     * open mode). Only meaningful after `requireAgentToken` runs.
     */
    agentMachineId: string | null;
  }
}

/**
 * Agents are machines, not people: they have no user account, no session and
 * no role, so they authenticate with a bearer secret rather than a JWT.
 *
 * Two mechanisms, both accepted:
 *  1. A per-agent credential (agent-credentials module) — scoped to one
 *     machineId, individually revocable. The intended long-term mechanism.
 *  2. The shared `AGENT_TOKEN` env var — unscoped, all-or-nothing. Kept as a
 *     fallback/bootstrap path so existing deployments keep working while
 *     hosts are migrated onto their own credentials one at a time, not as a
 *     breaking flag-day cutover.
 *
 * `AGENT_TOKEN` is required in production if no other auth is configured —
 * the server refuses to boot without it (see server.ts). That boot gate is
 * deliberately still anchored to `AGENT_TOKEN` alone, not "does at least one
 * active credential exist": it runs before the database connects (see
 * server.ts's ordering), so there's nothing to query yet. Per-agent
 * credentials are an addition layered on top of that gate at request time,
 * not a replacement for it — the dev-only open mode below (no `AGENT_TOKEN`
 * configured) is unreachable in production as a result, exactly as before.
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
  req.agentMachineId = null;

  // Dev-only open mode: nothing is enforced, exactly as before per-agent
  // credentials existed. Unreachable in production — the boot gate in
  // server.ts refuses to start without AGENT_TOKEN set.
  if (!env.AGENT_TOKEN) return;

  const header = req.headers.authorization;
  const provided = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;

  if (provided) {
    // Per-agent credentials look like `<tokenId>.<secret>` (see
    // agent-credentials.service.ts) — try that first when the shape matches,
    // but still fall through to the shared-secret check below regardless of
    // the outcome, rather than assuming the dot means it can't also be a
    // (pathological, dot-containing) AGENT_TOKEN value.
    if (provided.includes('.')) {
      const match = await verifyAgentCredential(provided);
      if (match) {
        req.agentMachineId = match.machineId;
        return;
      }
    }
    if (safeEqual(provided, env.AGENT_TOKEN)) return; // legacy shared-secret path; no specific identity
  }

  await reply.status(401).send({
    code: 'AGENT_UNAUTHORIZED',
    message: 'A valid agent token is required. Set AGENT_TOKEN on the agent to match the hub.',
  });
}

/**
 * Request-log level for the high-frequency agent routes (heartbeat, device
 * sync, stream frames, progress reports).
 *
 * Every agent heartbeats and syncs every 10 s and a remote stream posts up to
 * several frames a second, each logged as an incoming + completed pair at
 * `info`. Measured on a dev hub: the log reached ~800k lines with the tail
 * made of nothing else, burying the requests a person actually needs to find.
 * A production farm in this domain measured ~98 % of its log as this traffic
 * and moved it out of the default level. `warn` keeps errors and slow-request
 * warnings visible while dropping the routine pairs.
 */
export const AGENT_TRAFFIC_LOG_LEVEL = 'warn';
