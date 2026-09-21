import { EventEmitter } from 'events';
import { CaptureContext, CaptureHandle, CaptureSource, StreamProtocol } from '../capture-source';

/**
 * A pure relay target — no child process, no frames of its own. See
 * `streaming.service.ts`'s `AgentRelayCaptureSource` doc comment for the full
 * shape this is one half of.
 */
class AgentRelayHandle extends EventEmitter implements CaptureHandle {
  readonly pid = null;

  stop(): void {
    this.emit('exit');
  }
}

/**
 * The hub-side half of streaming's locality fix — the identical pattern
 * `appium.service.ts`'s `ensureRemoteAppiumServer` already applies to Appium,
 * see its doc comment and docs/reference-review-2026-09-14/01-architecture-
 * findings.md §1.3 for the shared rationale.
 *
 * Frames never originate here: adb/xcrun must run beside the device, which
 * this process cannot reach for an agent-owned device. The owning agent
 * captures locally (`agent/stream-runner.ts`, reusing the same
 * AdbMjpeg/AdbH264 sources unchanged) and POSTs each frame to
 * `POST /api/hosts/stream-frame`, which calls
 * `StreamingService#ingestRemoteFrame` to feed it into this handle — from
 * `StreamingService`'s point of view this looks exactly like a locally-
 * spawned handle emitting 'frame', it just never has a pid.
 *
 * `stop()` has nothing local to kill. The agent discovers a capture is no
 * longer wanted on its own next heartbeat poll: once `teardown()` flips this
 * session's `captureStatus` away from 'starting'/'active', it drops out of
 * `getDesiredStreamCapturesForMachine`'s query and the agent stops its own
 * adb/xcrun then. That is a bounded, one-heartbeat-interval delay — the same
 * trade-off already accepted everywhere else in this codebase where work is
 * agent-discovered rather than pushed.
 */
export class AgentRelayCaptureSource implements CaptureSource {
  readonly name = 'agent-relay';

  // The hub has no way to know what an arbitrary agent can actually produce —
  // that decision belongs to the agent's own capture source. Rejecting here
  // would just be a second, redundant guess at the same answer.
  supports(_protocol: StreamProtocol): boolean {
    return true;
  }

  start(_ctx: CaptureContext): CaptureHandle {
    return new AgentRelayHandle();
  }
}
