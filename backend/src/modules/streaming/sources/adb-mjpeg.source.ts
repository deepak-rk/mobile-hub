import { EventEmitter } from 'events';
import { spawn, ChildProcess } from 'child_process';
import { CaptureContext, CaptureHandle, CaptureSource, StreamProtocol } from '../capture-source';

const DEFAULT_FPS = 10;

/**
 * Grabs PNG frames from an Android device with
 * `adb -s <udid> exec-out screencap -p`, one child process per frame, paced
 * to a target frame rate.
 *
 * A screencap loop is used rather than `adb screenrecord` because screenrecord
 * emits an H264 stream (handled by a separate source) and buffers several
 * seconds before producing anything, which is unusable for a live view.
 */
class AdbMjpegHandle extends EventEmitter implements CaptureHandle {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private child: ChildProcess | null = null;
  private stopped = false;

  constructor(
    private readonly deviceUdid: string,
    private readonly adbPath: string,
    private readonly intervalMs: number,
  ) {
    super();
    this.tick();
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  private tick(): void {
    if (this.stopped) return;

    const child = spawn(this.adbPath, ['-s', this.deviceUdid, 'exec-out', 'screencap', '-p']);
    this.child = child;

    const chunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.stderr.on('data', (c: Buffer) => {
      const msg = c.toString().trim();
      // adb chatters on stderr; only surface something that looks fatal.
      if (/error|device .*not found|offline/i.test(msg)) this.emit('error', new Error(msg));
    });
    child.on('error', (err) => {
      if (!this.stopped) this.emit('error', err);
    });
    child.on('close', () => {
      if (this.stopped) return;
      if (chunks.length > 0) this.emit('frame', Buffer.concat(chunks));
      // Schedule the next grab only after this one finished, so a slow device
      // throttles itself instead of piling up overlapping adb processes.
      this.timer = setTimeout(() => this.tick(), this.intervalMs);
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.child?.kill();
    this.child = null;
    this.emit('exit');
  }
}

export class AdbMjpegCaptureSource implements CaptureSource {
  readonly name = 'adb-mjpeg';

  constructor(
    private readonly adbPath = process.env.ADB_PATH ?? 'adb',
    private readonly fps = DEFAULT_FPS,
  ) {}

  supports(protocol: StreamProtocol): boolean {
    return protocol === 'mjpeg';
  }

  start(ctx: CaptureContext): CaptureHandle {
    return new AdbMjpegHandle(ctx.deviceUdid, this.adbPath, Math.round(1000 / this.fps));
  }
}
