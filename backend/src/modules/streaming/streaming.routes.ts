import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { WebSocket } from 'ws';
import type { JwtPayload } from 'fastify-auth-kit';
import { resolveDevice } from '../devices/devices.service';
import { StreamSession } from './stream-session.model';
import { streamingService, StreamingError, shouldDropFrameForBackpressure } from './streaming.service';
import type { StreamProtocol } from './capture-source';
import { NotFoundError } from '../../common/errors/app-error';

const protocolQuery = z.object({
  protocol: z.enum(['mjpeg', 'h264']).default('mjpeg'),
  token: z.string().optional(),
});

/**
 * A WebSocket close reason must fit in **123 bytes** (RFC 6455); `ws` throws
 * a `RangeError` past that rather than truncating.
 *
 * That throw is not survivable here: it happens inside this file's async
 * socket handler, so it becomes an unhandled rejection and takes the whole
 * backend process down. Observed for real 2026-09-22 — one viewer attaching
 * to a device on a host already at its capture cap crashed the entire hub
 * for every user, because the `ANDROID_CAPTURE_CAPACITY` message is ~170
 * bytes and was passed to `close()` verbatim.
 *
 * Truncates by **bytes, not characters**: a `.slice(0, 120)` is not
 * sufficient on its own, since 120 multi-byte UTF-8 characters (a non-Latin
 * device name in an error message, say) still exceed 123 bytes. Cutting a
 * multi-byte character in half would leave a replacement character, so any
 * trailing one is dropped.
 */
export function safeCloseReason(text: string): string {
  const MAX_CLOSE_REASON_BYTES = 123;
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= MAX_CLOSE_REASON_BYTES) return text;
  return new TextDecoder('utf-8').decode(bytes.subarray(0, MAX_CLOSE_REASON_BYTES)).replace(/�+$/, '');
}

export const streamingRoutes: FastifyPluginAsync = async (app) => {
  app.get('/:udid/stream/status', async (req, reply) => {
    const { udid } = req.params as { udid: string };
    const sessions = await StreamSession.find({ deviceUdid: udid });
    if (sessions.length === 0) {
      return reply.send({ active: false, sessions: [] });
    }
    return { active: sessions.some((s) => s.captureStatus === 'active'), sessions };
  });

  app.post('/:udid/stream/stop', { preHandler: app.requireRole('operator', 'admin') }, async (req) => {
    const { udid } = req.params as { udid: string };
    const { machineId } = req.query as { machineId?: string };
    const device = await resolveDevice(udid, machineId || undefined);
    if (!device) throw new NotFoundError('Device not found');

    const stopped = await streamingService.stopForDevice(device.machineId, udid);
    return { stopped };
  });

  /**
   * Viewers attach here. The socket never starts a capture of its own — it
   * joins the one capture that exists per (host, device, protocol), which is
   * the whole point of the module (docs/modules/streaming.md).
   *
   * Auth rides in the query string because a browser WebSocket handshake
   * cannot carry an Authorization header.
   */
  app.get('/:udid/stream', { websocket: true }, (socket: WebSocket, req: FastifyRequest) => {
    void (async () => {
      const { udid } = req.params as { udid: string };
      const parsed = protocolQuery.safeParse(req.query);
      if (!parsed.success) {
        socket.close(4000, 'Invalid protocol');
        return;
      }
      const { protocol, token } = parsed.data;

      if (!token) {
        socket.close(4001, 'Missing token');
        return;
      }
      let viewer: JwtPayload;
      try {
        viewer = app.jwt.verify<JwtPayload>(token);
      } catch {
        socket.close(4001, 'Invalid token');
        return;
      }

      // `machineId` picks the host when the udid is on more than one; without
      // it an ambiguous udid is refused rather than streamed from a guess.
      const { machineId } = req.query as { machineId?: string };
      let device;
      try {
        device = await resolveDevice(udid, machineId || undefined);
      } catch {
        socket.close(4009, 'Device is on more than one host — specify machineId');
        return;
      }
      if (!device) {
        socket.close(4004, 'Device not found');
        return;
      }
      if (device.status === 'offline' || device.status === 'unreachable') {
        socket.close(4009, 'Device is offline');
        return;
      }

      // One viewer id per socket, so two tabs from the same user each count.
      const viewerId = `${viewer.sub}:${Math.random().toString(36).slice(2, 10)}`;

      // Attaching a viewer awaits the database, and a socket can close during
      // that await — a fast navigate-away, a reload, or React re-running an
      // effect. Registering the close handler only afterwards would lose that
      // event entirely, leaving a phantom viewer that never detaches and a
      // capture that therefore never reaches idle teardown. So record the
      // close now and reconcile once the attach resolves.
      let closedEarly = false;
      socket.on('close', () => {
        closedEarly = true;
      });

      try {
        const { session, detach } = await streamingService.addViewer({
          machineId: device.machineId,
          deviceUdid: udid,
          protocol: protocol as StreamProtocol,
          viewerId,
          platform: device.platform,
          isSimulator: device.connectionType === 'simulator',
          remoteEnabled: app.config.streaming.remoteEnabled,
          onFrame: (frame) => {
            if (socket.readyState !== socket.OPEN) return;
            // Skip, don't queue — see shouldDropFrameForBackpressure's doc
            // comment. The next frame that fits is still the newest one
            // available, since nothing is buffered here beyond `ws`'s own
            // send queue.
            if (shouldDropFrameForBackpressure(socket.bufferedAmount)) return;
            socket.send(frame);
          },
          // Pushed once, right before teardown drops this viewer along with
          // everyone else's — without this a broken capture just looked like
          // "starting..." forever (docs/architecture-blueprint.md's streaming
          // risk review). 1011 is the one non-retryable-code exclusion the
          // frontend hook already treats as "reconnect" — a fresh attempt is
          // exactly what should happen next.
          onError: (message) => {
            if (socket.readyState === socket.OPEN) {
              socket.send(JSON.stringify({ type: 'error', message }));
              socket.close(1011, safeCloseReason(message));
            }
          },
        });

        if (closedEarly) {
          // It went away while we were attaching; release it immediately.
          await detach();
          return;
        }

        socket.send(
          JSON.stringify({
            type: 'joined',
            sessionId: session.id as string,
            retryKey: session.retryKey,
            protocol,
          }),
        );

        socket.on('close', () => {
          void detach();
        });
      } catch (err) {
        if (err instanceof StreamingError) {
          // The capacity messages are deliberately long and explain how to fix
          // the situation — they must reach the user, but not verbatim as a
          // close reason. The full text already went out as a JSON `error`
          // frame above where one was sent; this is the protocol-limited echo.
          socket.close(4013, safeCloseReason(err.message));
          return;
        }
        req.log.error(err, 'Failed to attach stream viewer');
        socket.close(1011, 'Failed to start stream');
      }
    })().catch((err: unknown) => {
      // Last-resort net, same shape as triggerExecutionRun's: this IIFE is
      // fire-and-forget, so anything escaping the try/catch above — including
      // a throw from inside the catch block itself, which is exactly how the
      // close-reason RangeError killed the process — becomes an unhandled
      // rejection and terminates the backend for every user, not just this
      // viewer. One socket must never be able to do that.
      req.log.error(err, 'Unhandled error in stream socket handler');
      try {
        socket.close(1011, 'Failed to start stream');
      } catch {
        // The socket itself is the thing that failed; nothing left to do.
      }
    });
  });
};
