import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { TOKEN_STORAGE_KEY } from '@/services/api';

/** Mirrors the backend's ExecutionEvent union (execution.events.ts). */
export type ExecutionEvent =
  | { type: 'status'; status: string }
  | { type: 'stage'; stage: string; status: string; error?: string }
  | { type: 'log'; line: string };

export type StreamState = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'closed' | 'unauthenticated';

/** Cap retained log lines — a chatty run must not grow the DOM without bound. */
const MAX_LOG_LINES = 2000;
const RECONNECT_DELAY_MS = 2000;

function socketUrl(runId: string, token: string): string {
  const origin = import.meta.env.VITE_API_URL ?? window.location.origin;
  const base = origin.replace(/^http/, 'ws');
  // Auth rides in the query string: a browser WebSocket handshake can't
  // carry an Authorization header.
  return `${base}/api/execution/${runId}/stream?token=${encodeURIComponent(token)}`;
}

/**
 * Subscribes to a run's live event stream. Log lines accumulate here; status
 * and stage events invalidate the run query so the pipeline re-renders from
 * the authoritative record rather than from optimistic client state.
 *
 * Connection state is returned rather than hidden — guidelines §1 forbids
 * silently dropping a real-time connection.
 */
export function useRunStream(runId: string | undefined, enabled = true) {
  const [state, setState] = useState<StreamState>('idle');
  const [logLines, setLogLines] = useState<string[]>([]);
  const queryClient = useQueryClient();
  const socketRef = useRef<WebSocket | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!runId || !enabled) {
      setState('idle');
      return;
    }

    let token: string | null = null;
    try {
      token = localStorage.getItem(TOKEN_STORAGE_KEY);
    } catch {
      token = null;
    }
    if (!token) {
      // The stream requires a token; say so instead of retrying forever.
      setState('unauthenticated');
      return;
    }

    let disposed = false;
    let attempted = false;

    const connect = () => {
      if (disposed) return;
      setState(attempted ? 'reconnecting' : 'connecting');
      attempted = true;

      const ws = new WebSocket(socketUrl(runId, token));
      socketRef.current = ws;

      ws.onopen = () => {
        if (!disposed) setState('live');
      };

      ws.onmessage = (ev: MessageEvent<string>) => {
        let event: ExecutionEvent;
        try {
          event = JSON.parse(ev.data) as ExecutionEvent;
        } catch {
          return; // ignore anything that isn't a well-formed event
        }
        if (event.type === 'log') {
          setLogLines((prev) => {
            const next = [...prev, event.line];
            return next.length > MAX_LOG_LINES ? next.slice(-MAX_LOG_LINES) : next;
          });
        } else {
          void queryClient.invalidateQueries({ queryKey: ['runs', runId] });
          void queryClient.invalidateQueries({ queryKey: ['runs'] });
        }
      };

      ws.onclose = (ev) => {
        if (disposed) return;
        socketRef.current = null;
        // 4001 is the server rejecting the token — retrying can't help.
        if (ev.code === 4001) {
          setState('unauthenticated');
          return;
        }
        setState('closed');
        retryRef.current = setTimeout(connect, RECONNECT_DELAY_MS);
      };

      ws.onerror = () => {
        // onclose always follows; it owns the state transition.
      };
    };

    connect();

    return () => {
      disposed = true;
      if (retryRef.current) clearTimeout(retryRef.current);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [runId, enabled, queryClient]);

  return { state, logLines };
}
