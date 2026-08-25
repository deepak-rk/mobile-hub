import { EventEmitter } from 'events';

export type StreamProtocol = 'mjpeg' | 'h264';

export interface CaptureContext {
  deviceUdid: string;
  protocol: StreamProtocol;
}

/**
 * A running capture. Emits 'frame' (Buffer) and 'error' (Error), and 'exit'
 * when the underlying process ends for any reason.
 *
 * Exactly one of these exists per (machineId, deviceUdid, protocol) no matter
 * how many viewers are watching — the fan-out happens above this, in
 * StreamingService. Every comparable tool spawns one capture per viewer and
 * melts the host at three viewers; see docs/modules/streaming.md.
 */
export interface CaptureHandle extends EventEmitter {
  /** OS pid where the source has one; null for sources with no child process. */
  readonly pid: number | null;
  stop(): void;
}

/**
 * One adapter per way of grabbing frames off a device. Adding a new one
 * (scrcpy, WebDriverAgent, a cloud farm) means implementing this interface,
 * not touching StreamingService — the same shape as BuildProvider in builds/.
 */
export interface CaptureSource {
  readonly name: string;
  supports(protocol: StreamProtocol): boolean;
  start(ctx: CaptureContext): CaptureHandle;
}
