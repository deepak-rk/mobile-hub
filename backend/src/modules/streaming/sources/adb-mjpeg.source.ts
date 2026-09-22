import { EventEmitter } from 'events';
import { spawn, ChildProcess } from 'child_process';
import sharp from 'sharp';
import { CaptureContext, CaptureHandle, CaptureSource, StreamProtocol } from '../capture-source';

const DEFAULT_FPS = 10;
/** Real device screens run well past this; a live view doesn't need native resolution. */
const DEFAULT_MAX_WIDTH = 720;
/** Visually fine for a live view, a large fraction smaller than PNG — see the module doc comment. */
const DEFAULT_JPEG_QUALITY = 70;

/**
 * Resizes and JPEG-encodes a captured PNG frame — run wherever the frame
 * actually originates (this class is reused unchanged by both the hub-local
 * capture path and `agent/stream-runner.ts`'s agent-relay path, so this one
 * change point covers both without either needing to special-case the
 * other). Replaces shipping a full-resolution ~0.5MB PNG per frame, which was
 * most of "it feels slower than the old farm" (docs/SOURCE_FEATURE_TRACEABILITY.md
 * §4).
 */
async function compressFrame(png: Buffer, maxWidth: number, quality: number): Promise<Buffer> {
  return sharp(png)
    .resize({ width: maxWidth, withoutEnlargement: true })
    .jpeg({ quality })
    .toBuffer();
}

/**
 * Grabs PNG frames from an Android device with
 * `adb -s <udid> exec-out screencap -p`, one child process per frame, paced
 * to a target frame rate, then resizes + JPEG-compresses each before it ever
 * reaches a viewer.
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
    private readonly maxWidth: number,
    private readonly jpegQuality: number,
  ) {
    super();
    this.tick();
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  private tick(): void {
    if (this.stopped) return;

    // stdin explicitly ignored: screencap never reads it, but a spawned
    // process's default 'pipe' stdio leaves stdin open and unconsumed,
    // which can leave adb waiting on input that will never arrive and
    // hang indefinitely — reproduced when this runs as a long-lived child
    // of a background `tsx watch` process, though not in an earlier
    // one-shot verification script (see docs/LESSONS.md).
    const child = spawn(this.adbPath, ['-s', this.deviceUdid, 'exec-out', 'screencap', '-p'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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
      // Schedule the next grab only after this one is fully handled (capture
      // AND compression), so a slow device or a slow compress throttles
      // itself instead of piling up overlapping adb processes.
      const scheduleNext = () => {
        if (!this.stopped) this.timer = setTimeout(() => this.tick(), this.intervalMs);
      };
      if (chunks.length === 0) {
        scheduleNext();
        return;
      }
      const png = Buffer.concat(chunks);
      compressFrame(png, this.maxWidth, this.jpegQuality)
        .then((jpeg) => {
          if (!this.stopped) this.emit('frame', jpeg);
        })
        .catch((_err: unknown) => {
          // A single bad/corrupt PNG failing to re-encode must not tear down
          // the whole capture — every viewer's socket closes the moment this
          // handle emits 'error' (streaming.service.ts), which is a wildly
          // disproportionate response to one frame's compression failing.
          // Fall back to the uncompressed frame instead: one oversized frame
          // beats losing the live view entirely.
          if (!this.stopped) this.emit('frame', png);
        })
        .finally(scheduleNext);
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
    private readonly maxWidth = DEFAULT_MAX_WIDTH,
    private readonly jpegQuality = DEFAULT_JPEG_QUALITY,
  ) {}

  supports(protocol: StreamProtocol): boolean {
    return protocol === 'mjpeg';
  }

  start(ctx: CaptureContext): CaptureHandle {
    return new AdbMjpegHandle(
      ctx.deviceUdid,
      this.adbPath,
      Math.round(1000 / this.fps),
      this.maxWidth,
      this.jpegQuality,
    );
  }
}
