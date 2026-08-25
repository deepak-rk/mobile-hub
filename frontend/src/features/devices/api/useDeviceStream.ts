import { useEffect, useRef, useState } from 'react';
import { TOKEN_STORAGE_KEY } from '@/services/api';

export type StreamState =
  | 'idle'
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'offline'
  | 'unauthenticated'
  | 'rejected';

interface JoinAck {
  type: 'joined';
  sessionId: string;
  retryKey: string;
  protocol: string;
}

const RECONNECT_DELAY_MS = 2000;

function socketUrl(udid: string, token: string): string {
  const origin = import.meta.env.VITE_API_URL ?? window.location.origin;
  const base = origin.replace(/^http/, 'ws');
  return `${base}/api/devices/${udid}/stream?protocol=mjpeg&token=${encodeURIComponent(token)}`;
}

/**
 * Subscribes to a device's MJPEG stream. Frames arrive as binary WS messages
 * and are turned into object URLs for an <img>.
 *
 * `retryKey` changes when the backend restarted the capture rather than the
 * socket merely blipping, which the UI surfaces so a viewer knows the picture
 * may have jumped rather than silently showing stale-looking video.
 */
export function useDeviceStream(udid: string | undefined, enabled: boolean) {
  const [state, setState] = useState<StreamState>('idle');
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [restarted, setRestarted] = useState(false);

  const retryKeyRef = useRef<string | null>(null);
  const frameUrlRef = useRef<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!udid || !enabled) {
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
      setState('unauthenticated');
      return;
    }

    let disposed = false;
    let attempted = false;

    const revoke = () => {
      if (frameUrlRef.current) URL.revokeObjectURL(frameUrlRef.current);
      frameUrlRef.current = null;
    };

    const connect = () => {
      if (disposed) return;
      setState(attempted ? 'reconnecting' : 'connecting');
      attempted = true;

      const ws = new WebSocket(socketUrl(udid, token));
      ws.binaryType = 'blob';
      socketRef.current = ws;

      ws.onmessage = (ev: MessageEvent<Blob | string>) => {
        if (typeof ev.data === 'string') {
          try {
            const msg = JSON.parse(ev.data) as JoinAck;
            if (msg.type === 'joined') {
              if (retryKeyRef.current && retryKeyRef.current !== msg.retryKey) setRestarted(true);
              retryKeyRef.current = msg.retryKey;
              setState('live');
            }
          } catch {
            // not a control message we understand; ignore
          }
          return;
        }
        // Swap the object URL per frame, revoking the previous one so a long
        // session doesn't leak a URL for every frame received.
        const url = URL.createObjectURL(ev.data);
        revoke();
        frameUrlRef.current = url;
        setFrameUrl(url);
        setState('live');
      };

      ws.onclose = (ev) => {
        if (disposed) return;
        socketRef.current = null;
        // Distinct codes the backend uses; retrying can't fix any of them.
        if (ev.code === 4001) return setState('unauthenticated');
        if (ev.code === 4009) return setState('offline');
        if (ev.code === 4013 || ev.code === 4004 || ev.code === 4000) return setState('rejected');
        setState('reconnecting');
        timerRef.current = setTimeout(connect, RECONNECT_DELAY_MS);
      };
    };

    connect();

    return () => {
      disposed = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      socketRef.current?.close();
      socketRef.current = null;
      revoke();
    };
  }, [udid, enabled]);

  return { state, frameUrl, restarted, dismissRestarted: () => setRestarted(false) };
}
