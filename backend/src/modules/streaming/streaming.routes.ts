import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { WebSocket } from 'ws';
import type { JwtPayload } from 'fastify-auth-kit';
import { getDevice } from '../devices/devices.service';
import { StreamSession } from './stream-session.model';
import { streamingService, StreamingError } from './streaming.service';
import type { StreamProtocol } from './capture-source';

const protocolQuery = z.object({
  protocol: z.enum(['mjpeg', 'h264']).default('mjpeg'),
  token: z.string().optional(),
});

export const streamingRoutes: FastifyPluginAsync = async (app) => {
  app.get('/:udid/stream/status', async (req, reply) => {
    const { udid } = req.params as { udid: string };
    const sessions = await StreamSession.find({ deviceUdid: udid });
    if (sessions.length === 0) {
      return reply.send({ active: false, sessions: [] });
    }
    return { active: sessions.some((s) => s.captureStatus === 'active'), sessions };
  });

  app.post('/:udid/stream/stop', { preHandler: app.requireRole('operator', 'admin') }, async (req, reply) => {
    const { udid } = req.params as { udid: string };
    const device = await getDevice(udid);
    if (!device) return reply.status(404).send({ code: 'NOT_FOUND', message: 'Device not found' });

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

      const device = await getDevice(udid);
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
          onFrame: (frame) => {
            if (socket.readyState === socket.OPEN) socket.send(frame);
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
              socket.close(1011, message.slice(0, 120));
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
          socket.close(4013, err.message);
          return;
        }
        req.log.error(err, 'Failed to attach stream viewer');
        socket.close(1011, 'Failed to start stream');
      }
    })();
  });
};
