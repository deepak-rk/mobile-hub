import { useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { buildSocketUrl, useResilientWebSocket } from 'use-resilient-websocket';
import { TOKEN_STORAGE_KEY } from '@/services/api';

/** Mirrors the backend's InstallEvent union (install-runs.events.ts). */
export type InstallEvent = { type: 'target'; deviceUdid: string; status: string; progress: number; error?: string };

export type StreamState = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'closed' | 'unauthenticated';

function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * Same shape as execution's useRunStream: every event just invalidates the
 * run query so the UI renders from the authoritative record rather than
 * accumulating client-side state — a per-target progress event carries
 * nothing this component can't already get from a fresh GET.
 */
export function useInstallRunStream(installRunId: string | undefined, enabled = true) {
  const queryClient = useQueryClient();

  const token = enabled && installRunId ? readToken() : null;
  const url =
    token && installRunId
      ? buildSocketUrl(`/api/device-installs/${installRunId}/stream`, {
          origin: import.meta.env.VITE_API_URL || undefined,
          query: { token },
        })
      : null;

  const { state: wsState, closeCode } = useResilientWebSocket({
    url,
    onMessage: () => {
      void queryClient.invalidateQueries({ queryKey: ['device-installs', installRunId] });
    },
    nonRetryableCodes: [4001],
  });

  const state: StreamState = useMemo(() => {
    if (!enabled || !installRunId) return 'idle';
    if (!token) return 'unauthenticated';
    if (wsState === 'terminated') return closeCode === 4001 ? 'unauthenticated' : 'closed';
    return wsState;
  }, [enabled, installRunId, token, wsState, closeCode]);

  return { state };
}
