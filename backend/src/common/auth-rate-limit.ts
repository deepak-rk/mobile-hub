import { FastifyReply, FastifyRequest } from 'fastify';

/**
 * A small, self-contained fixed-window limiter for POST /api/auth/register
 * and .../login — brute-force protection backend/CLAUDE.md calls for,
 * independent of the app-wide `@fastify/rate-limit` registration.
 *
 * Not built on `@fastify/rate-limit`'s own `app.rateLimit()` decorator,
 * which looked like the obvious tool: that decorator's returned preHandler
 * shares a per-request guard flag (`req[rateLimitRan]`) with whichever
 * route-level check the global registration's own `onRoute` hook already
 * auto-attached to every route, `/register`/`/login` included. That global
 * check runs first (as an `onRequest` hook, ahead of any `preHandler`) and
 * marks the request as already rate-limited, so a second, independently
 * invoked check from the same plugin registration silently never fires —
 * confirmed by instrumenting it live, not assumed. A second, separately
 * *registered* instance of the plugin would sidestep that (fresh guard
 * symbol per registration), but only by auto-applying to every route in its
 * encapsulation scope — there's no way to scope it to just two of
 * `fastify-auth-kit`'s three internally-defined routes and exclude the
 * third (`GET /me`), which does not need it: it requires an already-valid
 * JWT, so it isn't brute-forceable the way credentials are, and lumping it
 * into the same tight bucket would tighten a request the frontend makes on
 * every page load — a real usability risk for anyone sharing an office IP.
 */
export function createAuthRateLimiter(max: number, windowMs: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();

  return async function authRateLimit(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const now = Date.now();
    const entry = hits.get(req.ip);

    if (!entry || entry.resetAt <= now) {
      hits.set(req.ip, { count: 1, resetAt: now + windowMs });
      return;
    }

    entry.count += 1;
    if (entry.count > max) {
      const retryAfterSeconds = Math.ceil((entry.resetAt - now) / 1000);
      void reply
        .status(429)
        .header('retry-after', retryAfterSeconds)
        .send({
          code: 'RATE_LIMITED',
          message: `Too many login/registration attempts. Try again in ${retryAfterSeconds}s.`,
        });
    }
  };
}
