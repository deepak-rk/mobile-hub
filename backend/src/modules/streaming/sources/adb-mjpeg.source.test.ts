import { EventEmitter } from 'events';
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import sharp from 'sharp';
import { AdbMjpegCaptureSource } from './adb-mjpeg.source';

/**
 * Regression for the "ships full PNG" gap (docs/SOURCE_FEATURE_TRACEABILITY.md
 * §4): every captured frame is now resized + JPEG-compressed before it's
 * emitted, wherever this source runs (hub-local or the agent-relay path both
 * reuse this class unchanged, so one test here covers both origins).
 *
 * `child_process.spawn` is mocked rather than shelling out to a real `adb` —
 * this source is exercised end-to-end elsewhere via the streaming module's
 * live-verification passes; this test is about the compression step, which
 * needs a controllable "adb produced these exact bytes" input.
 */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
}

let currentChild: FakeChild;
const spawnSpy = vi.fn(() => {
  currentChild = new FakeChild();
  return currentChild;
});

vi.mock('child_process', () => ({
  spawn: () => spawnSpy(),
}));

function emitPng(png: Buffer) {
  currentChild.stdout.emit('data', png);
  currentChild.emit('close');
}

let realPng: Buffer;

beforeAll(async () => {
  // A real, valid, larger-than-target-width PNG — big enough that resize()
  // actually has something to shrink (1000px wide vs. the 720px default cap).
  realPng = await sharp({
    create: { width: 1000, height: 600, channels: 3, background: { r: 10, g: 120, b: 200 } },
  })
    .png()
    .toBuffer();
});

afterEach(() => {
  spawnSpy.mockClear();
});

describe('AdbMjpegCaptureSource', () => {
  it('emits a JPEG frame (not the raw PNG) for a valid capture', async () => {
    const source = new AdbMjpegCaptureSource('adb', 10, 720, 70);
    const handle = source.start({ deviceUdid: 'd1', protocol: 'mjpeg' });

    const framePromise = new Promise<Buffer>((resolve) => handle.on('frame', resolve));
    emitPng(realPng);
    const frame = await framePromise;
    handle.stop();

    // JPEG magic bytes (FF D8 FF); the input started as a PNG (89 50 4E 47).
    expect(frame[0]).toBe(0xff);
    expect(frame[1]).toBe(0xd8);
    expect(frame[2]).toBe(0xff);
  });

  it('resizes down to the configured max width', async () => {
    const source = new AdbMjpegCaptureSource('adb', 10, 720, 70);
    const handle = source.start({ deviceUdid: 'd1', protocol: 'mjpeg' });

    const framePromise = new Promise<Buffer>((resolve) => handle.on('frame', resolve));
    emitPng(realPng); // 1000px wide source
    const frame = await framePromise;
    handle.stop();

    const meta = await sharp(frame).metadata();
    expect(meta.width).toBeLessThanOrEqual(720);
  });

  it('produces a materially smaller frame than the original PNG', async () => {
    const source = new AdbMjpegCaptureSource('adb', 10, 720, 70);
    const handle = source.start({ deviceUdid: 'd1', protocol: 'mjpeg' });

    const framePromise = new Promise<Buffer>((resolve) => handle.on('frame', resolve));
    emitPng(realPng);
    const frame = await framePromise;
    handle.stop();

    expect(frame.length).toBeLessThan(realPng.length);
  });

  it('does not upscale a frame already under the max width', async () => {
    const small = await sharp({
      create: { width: 200, height: 100, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();

    const source = new AdbMjpegCaptureSource('adb', 10, 720, 70);
    const handle = source.start({ deviceUdid: 'd1', protocol: 'mjpeg' });

    const framePromise = new Promise<Buffer>((resolve) => handle.on('frame', resolve));
    emitPng(small);
    const frame = await framePromise;
    handle.stop();

    const meta = await sharp(frame).metadata();
    expect(meta.width).toBe(200); // withoutEnlargement: true
  });

  it('falls back to emitting the raw bytes, not an error, when compression fails', async () => {
    const source = new AdbMjpegCaptureSource('adb', 10, 720, 70);
    const handle = source.start({ deviceUdid: 'd1', protocol: 'mjpeg' });

    const frames: Buffer[] = [];
    const errors: Error[] = [];
    handle.on('frame', (f: Buffer) => frames.push(f));
    handle.on('error', (e: Error) => errors.push(e));

    const garbage = Buffer.from('this is not a png');
    emitPng(garbage);
    // Waits for the outcome rather than a fixed 50 ms: the rejection comes
    // from sharp's thread pool, which took longer than that when the full
    // suite ran in CI alongside the MongoDB tests.
    await vi.waitFor(() => expect(frames.length + errors.length).toBeGreaterThan(0), { timeout: 5_000 });
    handle.stop();

    // A single bad frame must not tear down the capture — see the source's
    // own doc comment: emitting 'error' closes every viewer's socket, which
    // is disproportionate to one frame failing to re-encode.
    expect(errors).toEqual([]);
    expect(frames).toEqual([garbage]);
  });
});
