import { EventEmitter } from 'events';
import { spawn, ChildProcess } from 'child_process';
import { CaptureContext, CaptureHandle, CaptureSource, StreamProtocol } from '../capture-source';

const DEFAULT_SEGMENT_SECONDS = 2;
/** Fixed path, overwritten every segment — nothing accumulates on the device. */
const REMOTE_SEGMENT_PATH = '/data/local/tmp/mobilehub-h264-segment.mp4';

/**
 * Segmented H264 capture via `adb shell screenrecord`.
 *
 * IMPORTANT, read before touching this file: this is NOT a low-latency live
 * stream the way MJPEG is. Verified directly against a real emulator
 * (Pixel_3a_API_34, 2026-08-27) before writing any of this:
 *
 *  - This device's `screenrecord` (v1.3) has no `--output-format` flag and
 *    cannot write to stdout at all, via `shell` or `exec-out` (`Unable to
 *    open '-': Read-only file system`) — there is no raw Annex-B elementary
 *    stream available to pipe, unlike what the adb-mjpeg.source.ts comment
 *    implies. It can only write a complete file, on-device, then be read
 *    back after the process exits.
 *  - `--time-limit 0` removes the historical 3-minute cap, so a single long
 *    recording IS possible — but nothing can read a `screenrecord` file
 *    while it's mid-write for a *live* view; the whole point of a segment is
 *    that it becomes a valid, playable, standalone MP4 (moov present, not
 *    just mdat) only once that segment's process has exited.
 *  - Round-trip for one 1-second segment (record + exec-out cat back into a
 *    Buffer) measured ~1.4-1.5s wall clock — i.e. materially *slower* than
 *    real time, before any frontend playback/decode is added on top. A
 *    continuous low-latency H264 view (scrcpy-grade) needs a custom
 *    on-device capture agent using MediaProjection/MediaCodec directly, not
 *    plain adb screenrecord — that's a genuinely separate, larger feature,
 *    out of scope here.
 *
 * So: this source produces real, valid, sequential H264 segments — genuinely
 * smoother motion *within* a segment than MJPEG's discrete stills, and a
 * real, working end-to-end feature — but it is a higher-latency, seamed
 * alternative to MJPEG, not a replacement or an unconditional improvement.
 * See docs/TODO.md and docs/LESSONS.md for the full writeup; do not describe
 * this as "the pleasant live view" without that context.
 */
class AdbH264Handle extends EventEmitter implements CaptureHandle {
  private child: ChildProcess | null = null;
  private stopped = false;

  constructor(
    private readonly deviceUdid: string,
    private readonly adbPath: string,
    private readonly segmentSeconds: number,
  ) {
    super();
    this.recordNextSegment();
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  private recordNextSegment(): void {
    if (this.stopped) return;

    // Step 1: record a fixed-length segment to a file on the device. Killing
    // this process early would still leave a truncated/unreadable file in
    // practice (screenrecord needs to finalize the container on exit), so
    // segment length is controlled entirely via --time-limit, not by us
    // stopping it partway.
    const record = spawn(this.adbPath, [
      '-s',
      this.deviceUdid,
      'shell',
      `screenrecord --time-limit ${this.segmentSeconds} ${REMOTE_SEGMENT_PATH}`,
    ]);
    this.child = record;

    let recordErr = '';
    record.stderr.on('data', (c: Buffer) => (recordErr += c.toString()));
    record.on('error', (err) => {
      if (!this.stopped) this.emit('error', err);
    });

    record.on('close', (code) => {
      if (this.stopped) return;
      if (code !== 0) {
        this.emit('error', new Error(`screenrecord exited ${code}: ${recordErr.trim()}`));
        // Still schedule the next attempt — a single failed segment (e.g. a
        // transient device hiccup) shouldn't end the whole capture, matching
        // how the MJPEG source tolerates individual grab failures.
        this.recordNextSegment();
        return;
      }
      this.pullSegment();
    });
  }

  private pullSegment(): void {
    if (this.stopped) return;

    // Step 2: read the now-finalized, valid MP4 back as one Buffer.
    // exec-out, not `adb pull` to a local temp file — matches
    // adb-mjpeg.source.ts's pattern (collect stdout chunks directly) and
    // avoids filesystem cleanup on this side entirely. Verified byte-
    // identical to `adb pull` output.
    const cat = spawn(this.adbPath, ['-s', this.deviceUdid, 'exec-out', 'cat', REMOTE_SEGMENT_PATH]);
    this.child = cat;

    const chunks: Buffer[] = [];
    cat.stdout.on('data', (c: Buffer) => chunks.push(c));
    cat.on('error', (err) => {
      if (!this.stopped) this.emit('error', err);
    });

    cat.on('close', () => {
      if (this.stopped) return;
      if (chunks.length > 0) this.emit('frame', Buffer.concat(chunks));
      this.recordNextSegment();
    });
  }

  stop(): void {
    this.stopped = true;
    // The local adb client process is what we can actually kill; a `shell`
    // invocation's remote process on the device is not reachable by killing
    // the local child (a well-known adb limitation) — but since segment
    // length is bounded by --time-limit regardless, an in-flight recording
    // simply finishes on its own on the device with nothing listening for
    // its output, which is harmless.
    this.child?.kill();
    this.child = null;
    this.emit('exit');
  }
}

export class AdbH264CaptureSource implements CaptureSource {
  readonly name = 'adb-h264';

  constructor(
    private readonly adbPath = process.env.ADB_PATH ?? 'adb',
    private readonly segmentSeconds = DEFAULT_SEGMENT_SECONDS,
  ) {}

  supports(protocol: StreamProtocol): boolean {
    return protocol === 'h264';
  }

  start(ctx: CaptureContext): CaptureHandle {
    return new AdbH264Handle(ctx.deviceUdid, this.adbPath, this.segmentSeconds);
  }
}
