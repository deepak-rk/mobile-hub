import { describe, it, expect } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';
import { safeCloseReason } from './streaming.routes';
import { StreamingError } from './streaming.service';
import { env } from '../../config/env';

/**
 * Regression for the worst bug found 2026-09-22: a WebSocket close reason
 * must fit in 123 bytes (RFC 6455), and `ws` throws a `RangeError` past that
 * rather than truncating. `streaming.routes.ts` passed a `StreamingError`'s
 * message to `socket.close()` verbatim, and the capacity messages are ~170
 * bytes — so a single viewer attaching to a device on a host already at its
 * capture cap threw inside the socket handler's own catch block, became an
 * unhandled rejection, and **terminated the entire backend process** for
 * every user. Verified live: the hub went down and stopped answering on
 * :3000 entirely.
 *
 * These tests use a real `ws` server rather than a mock precisely because the
 * throw comes from `ws`'s own sender, not from any code here — a mocked
 * socket would happily accept an over-long reason and prove nothing.
 */
describe('safeCloseReason', () => {
  it('leaves a short reason untouched', () => {
    expect(safeCloseReason('Device is offline')).toBe('Device is offline');
  });

  it('truncates a reason longer than the 123-byte protocol limit', () => {
    const long = 'x'.repeat(300);
    const result = safeCloseReason(long);
    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(123);
  });

  it('measures bytes, not characters — multi-byte text under 123 chars can still exceed 123 bytes', () => {
    // 120 characters, but 3 bytes each in UTF-8 = 360 bytes. A .slice(0, 120)
    // would have let this straight through to the RangeError.
    const multibyte = '日'.repeat(120);
    expect(multibyte.length).toBeLessThan(123);
    expect(Buffer.byteLength(multibyte, 'utf8')).toBeGreaterThan(123);

    const result = safeCloseReason(multibyte);
    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(123);
    // Cut cleanly at a character boundary, no replacement character left behind.
    expect(result).not.toContain('�');
  });

  it('is long enough to matter: the real capacity message genuinely exceeds the limit', () => {
    const real = new StreamingError(
      'ANDROID_CAPTURE_CAPACITY',
      `Host dev-host already has ${env.ANDROID_STREAM_CAP} active captures; adb/host resources ` +
        `degrade per additional stream. Stop one before starting another (raise ANDROID_STREAM_CAP if this ` +
        `host has room).`,
    );
    // If this ever stops being true the bug is unreachable, but the guard stays.
    expect(Buffer.byteLength(real.message, 'utf8')).toBeGreaterThan(123);
    expect(Buffer.byteLength(safeCloseReason(real.message), 'utf8')).toBeLessThanOrEqual(123);
  });
});

describe('a real ws socket', () => {
  /** Opens one real client/server pair and hands back the server-side socket. */
  async function connectedPair(): Promise<{ server: WebSocketServer; socket: WebSocket; client: WebSocket }> {
    const server = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const { port } = server.address() as { port: number };

    const socketPromise = new Promise<WebSocket>((resolve) => server.once('connection', resolve));
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve) => client.once('open', resolve));

    return { server, socket: await socketPromise, client };
  }

  it('throws a RangeError on an over-long close reason — the crash this guards against', async () => {
    const { server, socket, client } = await connectedPair();

    expect(() => socket.close(4013, 'x'.repeat(200))).toThrow(RangeError);

    client.terminate();
    server.close();
  });

  it('accepts the same reason once passed through safeCloseReason', async () => {
    const { server, socket, client } = await connectedPair();

    expect(() => socket.close(4013, safeCloseReason('x'.repeat(200)))).not.toThrow();

    client.terminate();
    server.close();
  });
});
