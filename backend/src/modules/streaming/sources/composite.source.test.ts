import { describe, it, expect, vi } from 'vitest';
import { CompositeCaptureSource } from './composite.source';
import type { CaptureHandle, CaptureSource, StreamProtocol } from '../capture-source';

// Returns the CaptureSource alongside its start() spy as a plain variable
// (not read back through the interface-typed property) — asserting via the
// interface's `start` trips @typescript-eslint/unbound-method, since
// CaptureSource declares it as a method signature rather than a function-
// typed property, even though it's a vi.fn() at runtime.
function fakeSource(name: string, protocols: StreamProtocol[]) {
  const start = vi.fn(() => ({ pid: null, stop: vi.fn() }) as unknown as CaptureHandle);
  const source: CaptureSource = {
    name,
    supports: (p) => protocols.includes(p),
    start,
  };
  return { source, start };
}

describe('CompositeCaptureSource', () => {
  it('reports support only via its member sources', () => {
    const { source } = fakeSource('mjpeg-src', ['mjpeg']);
    const composite = new CompositeCaptureSource([source]);
    expect(composite.supports('mjpeg')).toBe(true);
    expect(composite.supports('h264')).toBe(false);
  });

  it('dispatches start() to the source that supports the requested protocol', () => {
    const mjpeg = fakeSource('mjpeg-src', ['mjpeg']);
    const h264 = fakeSource('h264-src', ['h264']);
    const composite = new CompositeCaptureSource([mjpeg.source, h264.source]);

    composite.start({ deviceUdid: 'd1', protocol: 'h264' });

    expect(h264.start).toHaveBeenCalledOnce();
    expect(mjpeg.start).not.toHaveBeenCalled();
  });

  it('throws rather than silently picking a wrong source when nothing supports the protocol', () => {
    const { source } = fakeSource('mjpeg-src', ['mjpeg']);
    const composite = new CompositeCaptureSource([source]);
    expect(() => composite.start({ deviceUdid: 'd1', protocol: 'h264' })).toThrow(/h264/);
  });

  it('picks the first matching source when more than one claims support', () => {
    const first = fakeSource('first', ['mjpeg']);
    const second = fakeSource('second', ['mjpeg']);
    const composite = new CompositeCaptureSource([first.source, second.source]);

    composite.start({ deviceUdid: 'd1', protocol: 'mjpeg' });

    expect(first.start).toHaveBeenCalledOnce();
    expect(second.start).not.toHaveBeenCalled();
  });
});
