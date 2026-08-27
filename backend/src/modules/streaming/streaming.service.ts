import { randomUUID } from 'crypto';
import { CaptureHandle, CaptureSource, StreamProtocol } from './capture-source';
import { AdbMjpegCaptureSource } from './sources/adb-mjpeg.source';
import { AdbH264CaptureSource } from './sources/adb-h264.source';
import { SyntheticCaptureSource } from './sources/synthetic.source';
import { CompositeCaptureSource } from './sources/composite.source';
import { StreamSession, IStreamSession } from './stream-session.model';

export class StreamingError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'StreamingError';
  }
}

/** `xcrun simctl` silently drops frames past this many concurrent recordings on one host. */
export const IOS_SIMULATOR_STREAM_CAP = 8;
/** Grace period before a viewer-less capture is torn down. */
export const IDLE_TEARDOWN_MS = 10 * 60 * 1000;
export const IDLE_SWEEP_INTERVAL_MS = 60 * 1000;

export type FrameListener = (frame: Buffer) => void;

interface LiveCapture {
  key: string;
  machineId: string;
  deviceUdid: string;
  protocol: StreamProtocol;
  handle: CaptureHandle;
  /** Viewer id -> its frame callback. One capture, many listeners. */
  viewers: Map<string, FrameListener>;
  idleSince: number | null;
}

function captureKey(machineId: string, deviceUdid: string, protocol: StreamProtocol): string {
  return `${machineId}::${deviceUdid}::${protocol}`;
}

/**
 * Owns every live capture in this process.
 *
 * The invariant that matters: **one capture per (machineId, deviceUdid,
 * protocol), regardless of viewer count.** Every comparable tool spawns a
 * capture per viewer and falls over at three viewers on one device
 * (docs/modules/streaming.md). Viewers attach to an existing capture here;
 * they never cause a second one.
 */
class StreamingService {
  private captures = new Map<string, LiveCapture>();
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly source: CaptureSource = resolveCaptureSource()) {}

  get sourceName(): string {
    return this.source.name;
  }

  /**
   * Attaches a viewer, starting the capture only if it isn't already running.
   * Returns the session plus an unsubscribe function.
   */
  async addViewer(params: {
    machineId: string;
    deviceUdid: string;
    protocol: StreamProtocol;
    viewerId: string;
    platform?: 'android' | 'ios';
    isSimulator?: boolean;
    onFrame: FrameListener;
  }): Promise<{ session: IStreamSession; detach: () => Promise<void> }> {
    const { machineId, deviceUdid, protocol, viewerId, onFrame } = params;

    if (!this.source.supports(protocol)) {
      throw new StreamingError(
        'UNSUPPORTED_PROTOCOL',
        `Capture source '${this.source.name}' does not support protocol '${protocol}'.`,
      );
    }

    const key = captureKey(machineId, deviceUdid, protocol);
    let capture = this.captures.get(key);

    if (!capture) {
      await this.assertSimulatorCapacity(params);
      capture = this.startCapture(key, machineId, deviceUdid, protocol);
    }

    capture.viewers.set(viewerId, onFrame);
    capture.idleSince = null;

    const session = await this.upsertSession(capture);

    const detach = async () => {
      await this.removeViewer(key, viewerId);
    };

    return { session, detach };
  }

  private startCapture(
    key: string,
    machineId: string,
    deviceUdid: string,
    protocol: StreamProtocol,
  ): LiveCapture {
    const handle = this.source.start({ deviceUdid, protocol });
    const capture: LiveCapture = {
      key,
      machineId,
      deviceUdid,
      protocol,
      handle,
      viewers: new Map(),
      idleSince: null,
    };

    handle.on('frame', (frame: Buffer) => {
      // Fan out one captured frame to every attached viewer.
      for (const listener of capture.viewers.values()) listener(frame);
    });

    handle.on('error', (err: Error) => {
      // A broken capture must not look like a quiet device: drop it so the
      // next viewer starts a fresh one, and let the record reflect reality.
      void this.teardown(key, `capture error: ${err.message}`);
    });

    this.captures.set(key, capture);
    return capture;
  }

  private async assertSimulatorCapacity(params: {
    machineId: string;
    platform?: 'android' | 'ios';
    isSimulator?: boolean;
  }): Promise<void> {
    if (params.platform !== 'ios' || !params.isSimulator) return;

    const active = await StreamSession.countDocuments({
      machineId: params.machineId,
      captureStatus: 'active',
      isSimulator: true,
    });
    if (active >= IOS_SIMULATOR_STREAM_CAP) {
      throw new StreamingError(
        'SIMULATOR_CAPACITY',
        `Host ${params.machineId} already has ${IOS_SIMULATOR_STREAM_CAP} iOS simulator streams; ` +
          `xcrun simctl silently drops frames beyond that. Stop one before starting another.`,
      );
    }
  }

  private async upsertSession(capture: LiveCapture): Promise<IStreamSession> {
    const viewerIds = [...capture.viewers.keys()];
    const session = await StreamSession.findOneAndUpdate(
      { machineId: capture.machineId, deviceUdid: capture.deviceUdid, protocol: capture.protocol },
      {
        captureStatus: 'active',
        capturePid: capture.handle.pid,
        viewerIds,
        viewerCount: viewerIds.length,
        lastViewerJoinedAt: new Date(),
        $setOnInsert: { retryKey: randomUUID(), startedAt: new Date() },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    return session;
  }

  private async removeViewer(key: string, viewerId: string): Promise<void> {
    const capture = this.captures.get(key);
    if (!capture) return;

    capture.viewers.delete(viewerId);
    const viewerIds = [...capture.viewers.keys()];

    await StreamSession.findOneAndUpdate(
      { machineId: capture.machineId, deviceUdid: capture.deviceUdid, protocol: capture.protocol },
      { viewerIds, viewerCount: viewerIds.length },
    );

    // Don't tear down immediately — a page reload drops and re-adds a viewer
    // within a second, and restarting a capture is expensive and visible.
    if (viewerIds.length === 0) capture.idleSince = Date.now();
  }

  /** Kills the capture and marks the session stopped. Safe to call twice. */
  async teardown(key: string, _reason = 'stopped'): Promise<void> {
    const capture = this.captures.get(key);
    if (!capture) return;

    this.captures.delete(key);
    capture.handle.stop();

    await StreamSession.findOneAndUpdate(
      { machineId: capture.machineId, deviceUdid: capture.deviceUdid, protocol: capture.protocol },
      { captureStatus: 'stopped', capturePid: null, viewerIds: [], viewerCount: 0 },
    );
  }

  async stopForDevice(machineId: string, deviceUdid: string): Promise<number> {
    const keys = [...this.captures.values()]
      .filter((c) => c.machineId === machineId && c.deviceUdid === deviceUdid)
      .map((c) => c.key);
    for (const key of keys) await this.teardown(key, 'stopped by operator');
    return keys.length;
  }

  /**
   * Rotates `retryKey` so a reconnecting client can tell "the stream
   * restarted, resync" from "my socket blipped, carry on".
   */
  async restartCapture(machineId: string, deviceUdid: string, protocol: StreamProtocol): Promise<void> {
    const key = captureKey(machineId, deviceUdid, protocol);
    await this.teardown(key, 'restarting');
    await StreamSession.findOneAndUpdate(
      { machineId, deviceUdid, protocol },
      { retryKey: randomUUID(), captureStatus: 'starting' },
    );
  }

  /** Tears down captures that have had no viewers for longer than the grace period. */
  async sweepIdle(now = Date.now()): Promise<number> {
    const stale = [...this.captures.values()].filter(
      (c) => c.viewers.size === 0 && c.idleSince !== null && now - c.idleSince >= IDLE_TEARDOWN_MS,
    );
    for (const capture of stale) await this.teardown(capture.key, 'idle timeout');
    return stale.length;
  }

  startIdleSweeper(onError?: (err: unknown) => void): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => {
      this.sweepIdle().catch((err: unknown) => onError?.(err));
    }, IDLE_SWEEP_INTERVAL_MS);
  }

  stopIdleSweeper(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
  }

  /** Live capture count — used by tests and diagnostics to prove sharing. */
  get activeCaptureCount(): number {
    return this.captures.size;
  }

  viewerCount(machineId: string, deviceUdid: string, protocol: StreamProtocol): number {
    return this.captures.get(captureKey(machineId, deviceUdid, protocol))?.viewers.size ?? 0;
  }

  /** Stops everything — called on shutdown so no capture outlives the process. */
  async shutdown(): Promise<void> {
    this.stopIdleSweeper();
    for (const key of [...this.captures.keys()]) await this.teardown(key, 'shutdown');
  }
}

function resolveCaptureSource(): CaptureSource {
  // Synthetic is opt-in only: a misconfigured deployment must fail loudly
  // against a real device, never quietly serve fake frames.
  if (process.env.STREAM_CAPTURE_SOURCE === 'synthetic') return new SyntheticCaptureSource();
  // Real per-protocol adapters, dispatched by CompositeCaptureSource. Adding
  // a protocol from here on is "write an adapter, add it to this list" —
  // StreamingService itself needs no change; see composite.source.ts.
  return new CompositeCaptureSource([new AdbMjpegCaptureSource(), new AdbH264CaptureSource()]);
}

export const streamingService = new StreamingService();
export { StreamingService, captureKey };
