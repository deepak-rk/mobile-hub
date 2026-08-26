import { useCallback, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { buildSocketUrl, useResilientWebSocket } from 'use-resilient-websocket';
import { TOKEN_STORAGE_KEY } from '@/services/api';

/** Mirrors the backend's ExecutionEvent union (execution.events.ts). */
export type ExecutionEvent =
  | { type: 'status'; status: string }
  | { type: 'stage'; stage: string; status: string; error?: string }
  | { type: 'log'; line: string };

export type StreamState = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'closed' | 'unauthenticated';

/** Cap retained log lines — a chatty run must not grow the DOM without bound. */
const MAX_LOG_LINES = 2000;

function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * Subscribes to a run's live event stream. Log lines accumulate here; status
 * and stage events invalidate the run query so the pipeline re-renders from
 * the authoritative record rather than from optimistic client state.
 *
 * Connection state is returned rather than hidden — guidelines §1 forbids
 * silently dropping a real-time connection.
 *
 * Reconnect/backoff/cleanup lives in `use-resilient-websocket`, which has no
 * opinion on auth — so the token pre-flight (no point opening a socket with
 * nothing to authenticate it) stays here, same as the JSON event parsing and
 * the query-invalidation side effect, both of which are this app's business,
 * not the transport's.
 */
export function useRunStream(runId: string | undefined, enabled = true) {
  const queryClient = useQueryClient();
  const [logLines, setLogLines] = useState<string[]>([]);

  const token = enabled && runId ? readToken() : null;
  const url =
    token && runId
      ? buildSocketUrl(`/api/execution/${runId}/stream`, {
          origin: import.meta.env.VITE_API_URL || undefined,
          query: { token },
        })
      : null;

  const handleMessage = useCallback(
    (event: MessageEvent<string>) => {
      let parsed: ExecutionEvent;
      try {
        parsed = JSON.parse(event.data) as ExecutionEvent;
      } catch {
        return; // ignore anything that isn't a well-formed event
      }
      if (parsed.type === 'log') {
        setLogLines((prev) => {
          const next = [...prev, parsed.line];
          return next.length > MAX_LOG_LINES ? next.slice(-MAX_LOG_LINES) : next;
        });
      } else {
        void queryClient.invalidateQueries({ queryKey: ['runs', runId] });
        void queryClient.invalidateQueries({ queryKey: ['runs'] });
      }
    },
    [queryClient, runId],
  );

  // 4001 is the server rejecting the token — retrying can't help.
  const { state: wsState, closeCode } = useResilientWebSocket({
    url,
    onMessage: handleMessage,
    nonRetryableCodes: [4001],
  });

  const state: StreamState = useMemo(() => {
    if (!enabled || !runId) return 'idle';
    if (!token) return 'unauthenticated';
    if (wsState === 'terminated') return closeCode === 4001 ? 'unauthenticated' : 'closed';
    return wsState;
  }, [enabled, runId, token, wsState, closeCode]);

  return { state, logLines };
}
