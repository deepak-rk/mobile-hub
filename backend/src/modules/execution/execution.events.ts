import { EventEmitter } from 'events';

export type ExecutionEvent =
  | { type: 'status'; status: string }
  | { type: 'stage'; stage: string; status: string; error?: string }
  | { type: 'log'; line: string };

const emitter = new EventEmitter();
emitter.setMaxListeners(0); // unbounded — any number of viewers may watch one run

export function publishExecutionEvent(runId: string, event: ExecutionEvent): void {
  emitter.emit(runId, event);
}

/** Returns an unsubscribe function. */
export function subscribeToExecutionEvents(runId: string, listener: (event: ExecutionEvent) => void): () => void {
  emitter.on(runId, listener);
  return () => emitter.off(runId, listener);
}
