import { CaptureHandle, CaptureSource, StreamProtocol } from '../modules/streaming/capture-source';
import { AdbMjpegCaptureSource } from '../modules/streaming/sources/adb-mjpeg.source';
import { AdbH264CaptureSource } from '../modules/streaming/sources/adb-h264.source';
import { CompositeCaptureSource } from '../modules/streaming/sources/composite.source';
import { DesiredStreamCapture, HubClient } from './hub-client';

/**
 * Runs adb/xcrun locally, on the agent, for this agent's own devices, and
 * relays every frame to the hub — the counterpart to
 * `modules/streaming/streaming.service.ts`'s hub-local path, same relation
 * `appium-runner.ts` has to `modules/execution/appium.service.ts`.
 *
 * Unlike appium-runner.ts, nothing here is *ported* — `AdbMjpegCaptureSource`/
 * `AdbH264CaptureSource` were already DB-free (no Mongoose coupling, unlike
 * Appium's hub-local logic), so they're reused unchanged via the same
 * `CompositeCaptureSource` dispatch the hub's own `resolveCaptureSource()`
 * uses by default. Only the destination for each captured frame differs: an
 * in-process `EventEmitter` listener on the hub, an HTTP POST to the hub here.
 *
 * Reconciled against a **desired-state list** on every heartbeat, not a
 * one-shot request/report the way Appium's is: streaming starts and stops as
 * viewers come and go, so `reconcile()` starts anything newly desired and
 * stops anything running that has dropped off the list, each poll. The
 * `running` map is itself the idempotency guard — no separate in-flight
 * tracking is needed the way installs/uninstalls/Appium requests need one,
 * since starting an already-running capture is just a no-op here.
 */
export class StreamRelay {
  private readonly running = new Map<string, CaptureHandle>();

  constructor(
    private readonly source: CaptureSource = new CompositeCaptureSource([
      new AdbMjpegCaptureSource(),
      new AdbH264CaptureSource(),
    ]),
    private readonly log: (level: 'info' | 'warn' | 'error', msg: string) => void = () => {},
  ) {}

  private static key(deviceUdid: string, protocol: StreamProtocol): string {
    return `${deviceUdid}::${protocol}`;
  }

  /** Live capture count — exposed for tests to prove reconcile() actually starts/stops. */
  get activeCount(): number {
    return this.running.size;
  }

  private start(hub: HubClient, machineId: string, deviceUdid: string, protocol: StreamProtocol): void {
    const key = StreamRelay.key(deviceUdid, protocol);
    if (this.running.has(key)) return;
    if (!this.source.supports(protocol)) {
      this.log('error', `no local capture source supports protocol '${protocol}' for ${deviceUdid}`);
      return;
    }

    const handle = this.source.start({ deviceUdid, protocol });
    this.running.set(key, handle);

    handle.on('frame', (frame: Buffer) => {
      void hub.postStreamFrame(machineId, deviceUdid, protocol, frame).catch((err: unknown) => {
        this.log(
          'warn',
          `relaying a frame for ${deviceUdid}/${protocol} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    });
    handle.on('error', (err: Error) => {
      void hub.postStreamError(machineId, deviceUdid, protocol, err.message).catch(() => undefined);
    });
  }

  private stop(deviceUdid: string, protocol: StreamProtocol): void {
    const key = StreamRelay.key(deviceUdid, protocol);
    const handle = this.running.get(key);
    if (!handle) return;
    handle.stop();
    this.running.delete(key);
  }

  /** Starts anything newly desired, stops anything running that's no longer wanted. Called once per heartbeat. */
  reconcile(hub: HubClient, machineId: string, desired: DesiredStreamCapture[]): void {
    const desiredKeys = new Set(desired.map((d) => StreamRelay.key(d.deviceUdid, d.protocol)));

    for (const d of desired) this.start(hub, machineId, d.deviceUdid, d.protocol);

    for (const key of [...this.running.keys()]) {
      if (desiredKeys.has(key)) continue;
      const sep = key.lastIndexOf('::');
      this.stop(key.slice(0, sep), key.slice(sep + 2) as StreamProtocol);
    }
  }

  /** Stops every capture this agent started — called on agent shutdown so nothing outlives the process that owns it. */
  shutdown(): void {
    for (const handle of this.running.values()) handle.stop();
    this.running.clear();
  }
}
