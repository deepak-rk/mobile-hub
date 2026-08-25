import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { StreamingService, IDLE_TEARDOWN_MS } from './streaming.service';
import { SyntheticCaptureSource } from './sources/synthetic.source';
import { StreamSession } from './stream-session.model';

/**
 * These cover the invariant the whole module exists for: one capture per
 * (host, device, protocol) no matter how many viewers attach. Every
 * comparable tool spawns one capture per viewer and collapses at three
 * viewers on a device (docs/modules/streaming.md).
 *
 * Mongo is stubbed so this runs anywhere; the capture source is the synthetic
 * one, so no device is needed either.
 */
function stubMongo() {
  const doc = {
    id: 'session-1',
    retryKey: 'retry-1',
    captureStatus: 'active',
  };
  vi.spyOn(StreamSession, 'findOneAndUpdate').mockReturnValue({
    // Mongoose queries are thenable; the service only ever awaits them.
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(doc).then(resolve),
  } as never);
  vi.spyOn(StreamSession, 'countDocuments').mockReturnValue({
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(0).then(resolve),
  } as never);
}

let service: StreamingService;

beforeEach(() => {
  stubMongo();
  // Fast frames so a test doesn't wait on wall-clock time.
  service = new StreamingService(new SyntheticCaptureSource(10));
});

afterEach(async () => {
  await service.shutdown();
  vi.restoreAllMocks();
});

const base = { machineId: 'host-1', deviceUdid: 'device-1', protocol: 'mjpeg' as const };

describe('viewer fan-out', () => {
  it('starts exactly one capture no matter how many viewers attach', async () => {
    await service.addViewer({ ...base, viewerId: 'v1', onFrame: () => {} });
    await service.addViewer({ ...base, viewerId: 'v2', onFrame: () => {} });
    await service.addViewer({ ...base, viewerId: 'v3', onFrame: () => {} });

    expect(service.activeCaptureCount).toBe(1);
    expect(service.viewerCount(base.machineId, base.deviceUdid, base.protocol)).toBe(3);
  });

  it('delivers the same frame to every attached viewer', async () => {
    const a: Buffer[] = [];
    const b: Buffer[] = [];
    await service.addViewer({ ...base, viewerId: 'v1', onFrame: (f) => a.push(f) });
    await service.addViewer({ ...base, viewerId: 'v2', onFrame: (f) => b.push(f) });

    await new Promise((r) => setTimeout(r, 60));

    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
    expect(a[0].toString()).toBe(b[0].toString());
  });

  it('keeps separate captures for different devices and protocols', async () => {
    await service.addViewer({ ...base, viewerId: 'v1', onFrame: () => {} });
    await service.addViewer({ ...base, deviceUdid: 'device-2', viewerId: 'v2', onFrame: () => {} });
    await service.addViewer({ ...base, protocol: 'h264', viewerId: 'v3', onFrame: () => {} });

    expect(service.activeCaptureCount).toBe(3);
  });

  it('stops delivering to a detached viewer while others keep receiving', async () => {
    const a: Buffer[] = [];
    const b: Buffer[] = [];
    const first = await service.addViewer({ ...base, viewerId: 'v1', onFrame: (f) => a.push(f) });
    await service.addViewer({ ...base, viewerId: 'v2', onFrame: (f) => b.push(f) });

    await new Promise((r) => setTimeout(r, 40));
    await first.detach();
    const aAtDetach = a.length;

    await new Promise((r) => setTimeout(r, 60));
    expect(a.length).toBe(aAtDetach); // detached viewer receives nothing further
    expect(b.length).toBeGreaterThan(aAtDetach); // the survivor keeps streaming
    expect(service.activeCaptureCount).toBe(1); // capture stays up for the survivor
  });
});

describe('early detach', () => {
  it('detaching before any frame arrives leaves no phantom viewer', async () => {
    // Mirrors a socket that closes while addViewer is still awaiting the
    // database — a fast navigate-away, a reload, or a re-run effect. A viewer
    // stranded here would never detach, so the capture would never reach idle
    // teardown and its process would run forever. (Found via the E2E suite;
    // the route now records an early close and reconciles once attach resolves.)
    const v = await service.addViewer({ ...base, viewerId: 'v1', onFrame: () => {} });
    await v.detach();

    expect(service.viewerCount(base.machineId, base.deviceUdid, base.protocol)).toBe(0);
    const swept = await service.sweepIdle(Date.now() + IDLE_TEARDOWN_MS + 1);
    expect(swept).toBe(1);
    expect(service.activeCaptureCount).toBe(0);
  });

  it('detaching twice is harmless', async () => {
    const v = await service.addViewer({ ...base, viewerId: 'v1', onFrame: () => {} });
    await v.detach();
    await expect(v.detach()).resolves.toBeUndefined();
    expect(service.viewerCount(base.machineId, base.deviceUdid, base.protocol)).toBe(0);
  });
});

describe('idle teardown', () => {
  it('keeps a viewer-less capture alive through the grace period', async () => {
    const v = await service.addViewer({ ...base, viewerId: 'v1', onFrame: () => {} });
    await v.detach();

    await service.sweepIdle(Date.now());
    expect(service.activeCaptureCount).toBe(1);
  });

  it('tears down a capture once it has been viewer-less past the grace period', async () => {
    const v = await service.addViewer({ ...base, viewerId: 'v1', onFrame: () => {} });
    await v.detach();

    const swept = await service.sweepIdle(Date.now() + IDLE_TEARDOWN_MS + 1);
    expect(swept).toBe(1);
    expect(service.activeCaptureCount).toBe(0);
  });

  it('does not tear down a capture a viewer rejoined during the grace period', async () => {
    const v = await service.addViewer({ ...base, viewerId: 'v1', onFrame: () => {} });
    await v.detach();
    await service.addViewer({ ...base, viewerId: 'v2', onFrame: () => {} });

    const swept = await service.sweepIdle(Date.now() + IDLE_TEARDOWN_MS + 1);
    expect(swept).toBe(0);
    expect(service.activeCaptureCount).toBe(1);
  });
});

describe('lifecycle', () => {
  it('stopForDevice kills every protocol for that device', async () => {
    await service.addViewer({ ...base, viewerId: 'v1', onFrame: () => {} });
    await service.addViewer({ ...base, protocol: 'h264', viewerId: 'v2', onFrame: () => {} });

    const stopped = await service.stopForDevice(base.machineId, base.deviceUdid);
    expect(stopped).toBe(2);
    expect(service.activeCaptureCount).toBe(0);
  });

  it('shutdown leaves no capture running', async () => {
    await service.addViewer({ ...base, viewerId: 'v1', onFrame: () => {} });
    await service.addViewer({ ...base, deviceUdid: 'device-2', viewerId: 'v2', onFrame: () => {} });

    await service.shutdown();
    expect(service.activeCaptureCount).toBe(0);
  });

  it('rejects a protocol the configured source cannot capture', async () => {
    const mjpegOnly = new StreamingService({
      name: 'mjpeg-only',
      supports: (p) => p === 'mjpeg',
      start: () => {
        throw new Error('should not be called');
      },
    });
    await expect(
      mjpegOnly.addViewer({ ...base, protocol: 'h264', viewerId: 'v1', onFrame: () => {} }),
    ).rejects.toThrow(/does not support/);
  });
});
