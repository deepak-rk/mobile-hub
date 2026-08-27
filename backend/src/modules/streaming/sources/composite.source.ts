import { CaptureContext, CaptureHandle, CaptureSource, StreamProtocol } from '../capture-source';

/**
 * Dispatches to the first configured source whose `supports()` accepts the
 * requested protocol.
 *
 * This is the piece docs/TODO.md's "protocol is already part of the session
 * key and the adapter interface, so it slots in without redesign" claim
 * glossed over: `StreamingService` previously took exactly one `CaptureSource`
 * (see `resolveCaptureSource()`), chosen once at construction — the
 * interface shape supported multiple protocols, but nothing actually
 * dispatched between sources for different ones. `StreamingService` itself
 * needed no change; only `resolveCaptureSource()`'s wiring did.
 */
export class CompositeCaptureSource implements CaptureSource {
  readonly name = 'composite';

  constructor(private readonly sources: readonly CaptureSource[]) {}

  supports(protocol: StreamProtocol): boolean {
    return this.sources.some((s) => s.supports(protocol));
  }

  start(ctx: CaptureContext): CaptureHandle {
    const source = this.sources.find((s) => s.supports(ctx.protocol));
    if (!source) {
      // StreamingService.addViewer already checks supports() before calling
      // start(), so this only fires on a wiring bug, not a normal request.
      throw new Error(`No configured capture source supports protocol '${ctx.protocol}'`);
    }
    return source.start(ctx);
  }
}
