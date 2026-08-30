import { EventEmitter } from 'events';

/**
 * Live progress for a build fetch, keyed by build id.
 *
 * Same pub/sub shape as execution's and device-installs' event modules. This
 * is the WS channel `docs/modules/builds.md` specified as
 * `/ws/builds/jobs/:jobId` — served here as `/api/builds/:id/stream` to match
 * the prefix every other stream in this app uses, and keyed by the build
 * rather than by the dead `InstallJob` model it was originally specified
 * against.
 *
 * `totalBytes` is null when the source declares no size; a subscriber must
 * then show indeterminate progress rather than computing a percentage.
 */
export type BuildEvent =
  | { type: 'progress'; downloadedBytes: number; totalBytes: number | null }
  | { type: 'status'; status: string; error?: string };

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

export function publishBuildEvent(buildId: string, event: BuildEvent): void {
  emitter.emit(buildId, event);
}

export function subscribeToBuildEvents(buildId: string, listener: (event: BuildEvent) => void): () => void {
  emitter.on(buildId, listener);
  return () => emitter.off(buildId, listener);
}
