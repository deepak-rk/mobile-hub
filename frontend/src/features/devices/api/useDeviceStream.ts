import { useCallback, useMemo, useRef, useState } from 'react';
import { buildSocketUrl, useObjectUrl, useResilientWebSocket } from 'use-resilient-websocket';
import { TOKEN_STORAGE_KEY } from '@/services/api';

export type StreamState =
  | 'idle'
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'offline'
  | 'unauthenticated'
  | 'rejected';

export type StreamProtocol = 'mjpeg' | 'h264';

interface JoinAck {
  type: 'joined';
  sessionId: string;
  retryKey: string;
  protocol: string;
}

function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * Subscribes to a device's live view. Frames/segments arrive as binary WS
 * messages and are turned into object URLs via `useObjectUrl` (revokes the
 * previous URL on every swap, so a long session doesn't leak one per
 * frame/segment) — that swap-and-revoke logic is identical for both
 * protocols, since `useObjectUrl` just wraps a `Blob`, whatever it contains.
 *
 * The two protocols are NOT equivalent, and the caller (`DeviceStream.tsx`)
 * renders them differently — `mjpeg` is a continuous stream of independent
 * still images (`<img>`), `h264` is a sequence of ~2s standalone video
 * segments (`<video>`, one `load()`+`play()` per new blob). See
 * `backend/src/modules/streaming/sources/adb-h264.source.ts`'s doc comment
 * for why h264 is real but higher-latency, not a low-latency replacement for
 * mjpeg — this hook just relays whichever protocol it's asked for.
 *
 * `retryKey` changes when the backend restarted the capture rather than the
 * socket merely blipping, which the UI surfaces so a viewer knows the picture
 * may have jumped rather than silently showing stale-looking video. That
 * detection is domain state read off the join ack, so it stays here rather
 * than in the transport-level package.
 *
 * `liveWhen: 'first-message'` matches the original behaviour precisely: the
 * transport can be open before the server has actually admitted this viewer
 * (the join ack is the real confirmation), so "live" waits for that first
 * message rather than the socket handshake alone.
 */
export function useDeviceStream(udid: string | undefined, enabled: boolean, protocol: StreamProtocol = 'mjpeg') {
  const [restarted, setRestarted] = useState(false);
  const retryKeyRef = useRef<string | null>(null);
  const frame = useObjectUrl();

  const token = enabled && udid ? readToken() : null;
  const url =
    token && udid
      ? buildSocketUrl(`/api/devices/${udid}/stream`, {
          origin: import.meta.env.VITE_API_URL || undefined,
          query: { protocol, token },
        })
      : null;

  const handleMessage = useCallback(
    (event: MessageEvent<Blob | string>) => {
      if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data) as JoinAck;
          if (msg.type === 'joined') {
            if (retryKeyRef.current && retryKeyRef.current !== msg.retryKey) setRestarted(true);
            retryKeyRef.current = msg.retryKey;
          }
        } catch {
          // not a control message we understand; ignore
        }
        return;
      }
      // A WS binary MessageEvent's Blob carries no useful MIME type (Chrome
      // reports it as text/plain). <img> doesn't care — image decoding is
      // content-sniffed regardless of blob.type — but <video> strictly
      // requires a correct type on its src blob or it never attempts to
      // decode at all: readyState stays 0 (HAVE_NOTHING) forever with no
      // error, which is exactly the "video never appears" failure this had
      // before the type was set explicitly here. Re-wrapping costs nothing
      // extra — Blob() over an existing Blob doesn't copy the bytes.
      frame.setFromBlob(protocol === 'h264' ? new Blob([event.data], { type: 'video/mp4' }) : event.data);
    },
    [frame, protocol],
  );

  // Every code the backend uses to say "don't bother retrying" — see
  // streaming.routes.ts. 1011 (internal error starting the capture) is
  // deliberately absent: that one is worth retrying.
  const { state: wsState, closeCode } = useResilientWebSocket({
    url,
    binaryType: 'blob',
    liveWhen: 'first-message',
    onMessage: handleMessage,
    nonRetryableCodes: [4000, 4001, 4004, 4009, 4013],
  });

  const state: StreamState = useMemo(() => {
    if (!enabled || !udid) return 'idle';
    if (!token) return 'unauthenticated';
    if (wsState === 'terminated') {
      if (closeCode === 4001) return 'unauthenticated';
      if (closeCode === 4009) return 'offline';
      return 'rejected'; // 4000 / 4004 / 4013, or an unexpected non-retryable close
    }
    return wsState;
  }, [enabled, udid, token, wsState, closeCode]);

  return { state, frameUrl: frame.url, restarted, dismissRestarted: () => setRestarted(false) };
}
