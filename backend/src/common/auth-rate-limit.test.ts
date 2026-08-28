import { describe, it, expect } from 'vitest';
import { FastifyReply, FastifyRequest } from 'fastify';
import { createAuthRateLimiter } from './auth-rate-limit';

/**
 * Not built on @fastify/rate-limit's own decorator — that decorator's
 * returned preHandler shares a per-request guard flag with whichever
 * route-level check the plugin's global registration already auto-attaches
 * to every route, so a second, independently invoked check from the same
 * registration silently never fires (confirmed live against a real server,
 * not assumed — see this file's own doc comment and docs/LESSONS.md).
 * These tests pin the standalone limiter's own behavior in isolation.
 */
function fakeReply() {
  const reply = {
    statusCode: 0,
    headers: {} as Record<string, unknown>,
    body: undefined as unknown,
    status(code: number) {
      reply.statusCode = code;
      return reply;
    },
    header(name: string, value: unknown) {
      reply.headers[name] = value;
      return reply;
    },
    send(payload: unknown) {
      reply.body = payload;
      return reply;
    },
  };
  return reply as unknown as FastifyReply & typeof reply;
}

const reqFrom = (ip: string) => ({ ip }) as FastifyRequest;

describe('createAuthRateLimiter', () => {
  it('allows requests up to the max within the window', async () => {
    const limiter = createAuthRateLimiter(3, 60_000);
    const reply = fakeReply();

    for (let i = 0; i < 3; i++) {
      await limiter(reqFrom('1.1.1.1'), reply);
    }

    expect(reply.statusCode).toBe(0); // never touched → every request allowed through
  });

  it('rejects the request that exceeds the max, with 429 and a retry-after header', async () => {
    const limiter = createAuthRateLimiter(2, 60_000);
    const reply = fakeReply();

    await limiter(reqFrom('2.2.2.2'), reply);
    await limiter(reqFrom('2.2.2.2'), reply);
    await limiter(reqFrom('2.2.2.2'), reply); // 3rd, over the max of 2

    expect(reply.statusCode).toBe(429);
    expect(reply.headers['retry-after']).toBeGreaterThan(0);
    expect((reply.body as { code: string }).code).toBe('RATE_LIMITED');
  });

  it('tracks each IP independently — one exhausting its bucket does not affect another', async () => {
    const limiter = createAuthRateLimiter(1, 60_000);
    const replyA = fakeReply();
    const replyB = fakeReply();

    await limiter(reqFrom('3.3.3.1'), replyA);
    await limiter(reqFrom('3.3.3.1'), replyA); // exhausts 3.3.3.1's bucket

    await limiter(reqFrom('3.3.3.2'), replyB); // a different IP, its own bucket

    expect(replyA.statusCode).toBe(429);
    expect(replyB.statusCode).toBe(0);
  });

  it('resets the bucket once the window has passed', async () => {
    const limiter = createAuthRateLimiter(1, 10);
    const reply1 = fakeReply();
    const reply2 = fakeReply();
    const reply3 = fakeReply();

    await limiter(reqFrom('4.4.4.4'), reply1);
    await limiter(reqFrom('4.4.4.4'), reply2); // over the max of 1, within the window
    expect(reply2.statusCode).toBe(429);

    await new Promise((r) => setTimeout(r, 15)); // past the 10ms window
    await limiter(reqFrom('4.4.4.4'), reply3);
    expect(reply3.statusCode).toBe(0); // window reset, allowed again
  });

  it('evicts an expired IP entry once the window has passed, bounding memory growth', async () => {
    // Guards against the map growing by one entry per unique IP ever seen
    // for the life of the process (docs/TODO.md's documented gap).
    const limiter = createAuthRateLimiter(5, 10);
    await limiter(reqFrom('6.6.6.1'), fakeReply());
    await limiter(reqFrom('6.6.6.2'), fakeReply());
    await limiter(reqFrom('6.6.6.3'), fakeReply());
    expect(limiter.trackedIpCount).toBe(3);

    await new Promise((r) => setTimeout(r, 15)); // past the 10ms window for all three

    // Eviction is lazy (runs on the next call, not on a timer), so it takes
    // one more request to trigger the sweep — that request's own IP re-adds
    // one entry, so the map should settle at 1, not 4.
    await limiter(reqFrom('6.6.6.4'), fakeReply());
    expect(limiter.trackedIpCount).toBe(1);
  });

  it('does not evict an IP whose window has not expired yet', async () => {
    const limiter = createAuthRateLimiter(5, 60_000);
    await limiter(reqFrom('7.7.7.1'), fakeReply());
    await limiter(reqFrom('7.7.7.2'), fakeReply());

    expect(limiter.trackedIpCount).toBe(2); // both still well within their window
  });

  it('two independently created limiters never share state', async () => {
    // Guards against accidentally reintroducing a shared/module-level Map.
    const limiterA = createAuthRateLimiter(1, 60_000);
    const limiterB = createAuthRateLimiter(1, 60_000);
    const replyA = fakeReply();
    const replyB = fakeReply();

    await limiterA(reqFrom('5.5.5.5'), replyA);
    await limiterA(reqFrom('5.5.5.5'), fakeReply()); // exhausts limiterA's bucket for this IP

    await limiterB(reqFrom('5.5.5.5'), replyB); // same IP, but limiterB's own fresh bucket

    expect(replyB.statusCode).toBe(0);
  });
});
