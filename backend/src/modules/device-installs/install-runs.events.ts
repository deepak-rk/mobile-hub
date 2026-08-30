import { EventEmitter } from 'events';

// Same pub/sub shape as execution/execution.events.ts, keyed by installRunId
// instead of runId — one emitter shared by every run, any number of
// subscribers per run (an unbounded number of viewers may be watching a
// given install's progress).
export type InstallEvent =
  | { type: 'target'; deviceUdid: string; status: string; progress: number; error?: string };

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

export function publishInstallEvent(installRunId: string, event: InstallEvent): void {
  emitter.emit(installRunId, event);
}

export function subscribeToInstallEvents(installRunId: string, listener: (event: InstallEvent) => void): () => void {
  emitter.on(installRunId, listener);
  return () => emitter.off(installRunId, listener);
}
