import { describe, it, expect, vi, afterEach } from 'vitest';
import Fastify from 'fastify';
import { hostsRoutes } from './hosts.routes';
import { streamingService } from '../streaming/streaming.service';

/**
 * POST /stream-frame relays an agent-captured frame straight into the viewer
 * fan-out. A 0-byte body is not a frame — passing it through sends viewers an
 * empty message (a blank/corrupt image for MJPEG, a broken segment for H264).
 * AGENT_TOKEN is unset under vitest, so requireAgentToken runs in open mode.
 */
async function buildApp() {
  const app = Fastify();
  app.decorate('authenticate', vi.fn());
  app.decorate('requireRole', () => vi.fn());
  await app.register(hostsRoutes);
  await app.ready();
  return app;
}

const url = '/stream-frame?machineId=host-a&deviceUdid=emulator-5554&protocol=mjpeg';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /stream-frame', () => {
  it('relays a non-empty frame to the streaming service', async () => {
    const ingest = vi.spyOn(streamingService, 'ingestRemoteFrame').mockReturnValue(true);
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from([0xff, 0xd8, 0xff]),
    });

    expect(res.statusCode).toBe(204);
    expect(ingest).toHaveBeenCalledWith('host-a', 'emulator-5554', 'mjpeg', Buffer.from([0xff, 0xd8, 0xff]));
    await app.close();
  });

  it('drops a 0-byte frame instead of fanning it out to viewers, still answering 204', async () => {
    const ingest = vi.spyOn(streamingService, 'ingestRemoteFrame').mockReturnValue(true);
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(0),
    });

    expect(res.statusCode).toBe(204);
    expect(ingest).not.toHaveBeenCalled();
    await app.close();
  });
});
