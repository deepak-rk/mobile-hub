import { EventEmitter } from 'events';
import { describe, it, expect, vi } from 'vitest';
import { StreamRelay } from './stream-runner';
import type { CaptureHandle, CaptureSource, StreamProtocol } from '../modules/streaming/capture-source';
import type { HubClient } from './hub-client';

/**
 * A fake local capture source whose handles are addressable from the test,
 * mirroring streaming.service.test.ts's flakySource. `stops` tracks each
 * handle's stop() spy as a plain variable rather than read back through
 * `handle.stop` — asserting via the interface-typed property trips
 * @typescript-eslint/unbound-method, the same reason composite.source.test.ts
 * keeps its `start` spy separate from the CaptureSource it's attached to.
 */
function fakeSource(): {
  source: CaptureSource;
  handles: Map<string, CaptureHandle & EventEmitter>;
  stops: Map<string, ReturnType<typeof vi.fn>>;
} {
  const handles = new Map<string, CaptureHandle & EventEmitter>();
  const stops = new Map<string, ReturnType<typeof vi.fn>>();
  const source: CaptureSource = {
    name: 'fake',
    supports: () => true,
    start: (ctx) => {
      const key = `${ctx.deviceUdid}::${ctx.protocol}`;
      const h = new EventEmitter() as CaptureHandle & EventEmitter;
      Object.defineProperty(h, 'pid', { value: 123 });
      const stop: ReturnType<typeof vi.fn> = vi.fn();
      h.stop = stop;
      handles.set(key, h);
      stops.set(key, stop);
      return h;
    },
  };
  return { source, handles, stops };
}

function fakeHub() {
  return {
    postStreamFrame: vi.fn().mockResolvedValue(undefined),
    postStreamError: vi.fn().mockResolvedValue(undefined),
  } as unknown as HubClient & { postStreamFrame: ReturnType<typeof vi.fn>; postStreamError: ReturnType<typeof vi.fn> };
}

const machineId = 'host-1';

describe('StreamRelay.reconcile', () => {
  it('starts a local capture for a newly desired device/protocol', () => {
    const { source } = fakeSource();
    const relay = new StreamRelay(source);
    const hub = fakeHub();

    relay.reconcile(hub, machineId, [{ deviceUdid: 'device-1', protocol: 'mjpeg' }]);

    expect(relay.activeCount).toBe(1);
  });

  it('is idempotent — reconciling the same desired set again does not restart the capture', () => {
    const { source, handles } = fakeSource();
    const relay = new StreamRelay(source);
    const hub = fakeHub();
    const desired = [{ deviceUdid: 'device-1', protocol: 'mjpeg' as StreamProtocol }];

    relay.reconcile(hub, machineId, desired);
    const first = handles.get('device-1::mjpeg');
    relay.reconcile(hub, machineId, desired);

    expect(handles.get('device-1::mjpeg')).toBe(first); // same handle, never restarted
    expect(relay.activeCount).toBe(1);
  });

  it('stops a running capture once it drops off the desired list', () => {
    const { source, stops } = fakeSource();
    const relay = new StreamRelay(source);
    const hub = fakeHub();

    relay.reconcile(hub, machineId, [{ deviceUdid: 'device-1', protocol: 'mjpeg' }]);
    relay.reconcile(hub, machineId, []);

    expect(stops.get('device-1::mjpeg')).toHaveBeenCalledOnce();
    expect(relay.activeCount).toBe(0);
  });

  it('relays every captured frame to the hub for the right device/protocol/machine', () => {
    const { source, handles } = fakeSource();
    const relay = new StreamRelay(source);
    const hub = fakeHub();

    relay.reconcile(hub, machineId, [{ deviceUdid: 'device-1', protocol: 'mjpeg' }]);
    handles.get('device-1::mjpeg')!.emit('frame', Buffer.from('a-frame'));

    expect(hub.postStreamFrame).toHaveBeenCalledWith(machineId, 'device-1', 'mjpeg', Buffer.from('a-frame'));
  });

  it('relays a capture error to the hub as postStreamError', () => {
    const { source, handles } = fakeSource();
    const relay = new StreamRelay(source);
    const hub = fakeHub();

    relay.reconcile(hub, machineId, [{ deviceUdid: 'device-1', protocol: 'mjpeg' }]);
    handles.get('device-1::mjpeg')!.emit('error', new Error('device offline'));

    expect(hub.postStreamError).toHaveBeenCalledWith(machineId, 'device-1', 'mjpeg', 'device offline');
  });

  it('a failed relay POST is caught and logged, not thrown back at reconcile', () => {
    const { source, handles } = fakeSource();
    const log = vi.fn();
    const relay = new StreamRelay(source, log);
    const hub = fakeHub();
    hub.postStreamFrame.mockRejectedValue(new Error('network blip'));

    expect(() => {
      relay.reconcile(hub, machineId, [{ deviceUdid: 'device-1', protocol: 'mjpeg' }]);
      handles.get('device-1::mjpeg')!.emit('frame', Buffer.from('x'));
    }).not.toThrow();
  });

  it('runs independent captures for different devices and protocols side by side', () => {
    const { source } = fakeSource();
    const relay = new StreamRelay(source);
    const hub = fakeHub();

    relay.reconcile(hub, machineId, [
      { deviceUdid: 'device-1', protocol: 'mjpeg' },
      { deviceUdid: 'device-1', protocol: 'h264' },
      { deviceUdid: 'device-2', protocol: 'mjpeg' },
    ]);

    expect(relay.activeCount).toBe(3);
  });
});

describe('StreamRelay.shutdown', () => {
  it('stops every running capture', () => {
    const { source, stops } = fakeSource();
    const relay = new StreamRelay(source);
    const hub = fakeHub();

    relay.reconcile(hub, machineId, [
      { deviceUdid: 'device-1', protocol: 'mjpeg' },
      { deviceUdid: 'device-2', protocol: 'h264' },
    ]);
    relay.shutdown();

    expect(stops.get('device-1::mjpeg')).toHaveBeenCalledOnce();
    expect(stops.get('device-2::h264')).toHaveBeenCalledOnce();
    expect(relay.activeCount).toBe(0);
  });
});
