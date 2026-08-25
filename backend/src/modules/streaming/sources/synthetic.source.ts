import { EventEmitter } from 'events';
import { CaptureContext, CaptureHandle, CaptureSource, StreamProtocol } from '../capture-source';
import { syntheticFrame } from './synthetic-frame';

/**
 * Emits generated frames on a timer instead of talking to a device.
 *
 * This exists so the part of streaming that is actually hard and actually
 * novel — one capture shared across N viewers, viewer bookkeeping, idle
 * teardown, reconnect correlation — can be exercised end to end on a machine
 * with no device attached, in CI, and in the E2E suite. The adb/simctl
 * adapters are thin by comparison; what they cannot verify is the fan-out.
 *
 * Selected with STREAM_CAPTURE_SOURCE=synthetic. Never selected implicitly.
 */
class SyntheticHandle extends EventEmitter implements CaptureHandle {
  private timer: ReturnType<typeof setInterval> | null = null;
  private frameNo = 0;

  constructor(_ctx: CaptureContext, intervalMs: number) {
    super();
    this.timer = setInterval(() => {
      this.frameNo += 1;
      // A real, decodable PNG whose colour cycles per frame, so a browser
      // shows an actual moving picture rather than a broken-image icon.
      this.emit('frame', syntheticFrame(this.frameNo));
    }, intervalMs);
  }

  /** No child process backs this source. */
  get pid(): number | null {
    return null;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.emit('exit');
  }
}

export class SyntheticCaptureSource implements CaptureSource {
  readonly name = 'synthetic';

  constructor(private readonly intervalMs = 200) {}

  supports(_protocol: StreamProtocol): boolean {
    return true;
  }

  start(ctx: CaptureContext): CaptureHandle {
    return new SyntheticHandle(ctx, this.intervalMs);
  }
}
