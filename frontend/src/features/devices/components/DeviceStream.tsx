import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Button } from 'react-design-kit';
import { icons, iconSize } from '@/lib/icons';
import { useAuth } from '@/features/auth/useAuth';
import { useDeviceStream, type StreamProtocol, type StreamState } from '../api/useDeviceStream';
import { useStopDeviceStream } from '../api/devices.api';
import { useFeatureDisabled } from '@/features/config/api/features.api';
import type { Device } from '../types';
import { pointToScreenFraction, TAP_SLOP } from '../lib/remoteControl';
import styles from './DeviceStream.module.css';

const BANNER: Record<StreamState, { text: string; tone: string }> = {
  idle: { text: 'Not streaming', tone: 'var(--text-tertiary)' },
  connecting: { text: 'Connecting…', tone: 'var(--status-running)' },
  live: { text: 'Live', tone: 'var(--status-idle)' },
  reconnecting: { text: 'Reconnecting…', tone: 'var(--status-smoke)' },
  offline: { text: 'Device offline', tone: 'var(--status-offline)' },
  unauthenticated: { text: 'Sign in to view', tone: 'var(--text-tertiary)' },
  rejected: { text: 'Stream unavailable', tone: 'var(--status-failed)' },
};

/**
 * Renders whichever protocol's blob just arrived. Not the same element for
 * both: mjpeg is a continuous stream of independent stills (`<img>`, the
 * browser repaints on its own whenever `src` changes); h264 is a sequence of
 * ~2s standalone video segments, and a `<video>` element does NOT reload on
 * a bare `src` change the way `<img>` does — each new segment needs an
 * explicit `load()` + `play()`, done here via a ref rather than in the hook,
 * since it's a DOM operation, not stream state.
 */
/** A press on the stream turned into a tap or a swipe, in screen fractions. */
export type StreamGesture =
  | { kind: 'tap'; x: number; y: number }
  | { kind: 'swipe'; x1: number; y1: number; x2: number; y2: number; durationMs: number };

function naturalSize(el: HTMLImageElement | HTMLVideoElement): [number, number] {
  return el instanceof HTMLVideoElement ? [el.videoWidth, el.videoHeight] : [el.naturalWidth, el.naturalHeight];
}

/** Pointer handlers that turn a press on the picture into a tap or swipe. */
function useGestureHandlers(onGesture?: (g: StreamGesture) => void) {
  const start = useRef<{ x: number; y: number; at: number } | null>(null);
  if (!onGesture) return {};
  const at = (e: React.PointerEvent<HTMLImageElement | HTMLVideoElement>) => {
    const el = e.currentTarget;
    const [w, h] = naturalSize(el);
    return pointToScreenFraction(e.clientX, e.clientY, el.getBoundingClientRect(), w, h);
  };
  return {
    onPointerDown: (e: React.PointerEvent<HTMLImageElement | HTMLVideoElement>) => {
      const p = at(e);
      start.current = p ? { ...p, at: Date.now() } : null;
    },
    onPointerUp: (e: React.PointerEvent<HTMLImageElement | HTMLVideoElement>) => {
      const from = start.current;
      start.current = null;
      const to = at(e);
      if (!from || !to) return;
      if (Math.hypot(to.x - from.x, to.y - from.y) < TAP_SLOP) {
        onGesture({ kind: 'tap', x: to.x, y: to.y });
      } else {
        const durationMs = Math.min(5000, Math.max(50, Date.now() - from.at));
        onGesture({ kind: 'swipe', x1: from.x, y1: from.y, x2: to.x, y2: to.y, durationMs });
      }
    },
    draggable: false,
    style: { cursor: 'pointer', touchAction: 'none' as const },
  };
}

function StreamFrame({
  protocol,
  frameUrl,
  deviceName,
  onGesture,
}: {
  protocol: StreamProtocol;
  frameUrl: string;
  deviceName: string;
  onGesture?: (g: StreamGesture) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const gestures = useGestureHandlers(onGesture);

  useEffect(() => {
    if (protocol !== 'h264') return;
    const el = videoRef.current;
    if (!el) return;
    el.load();
    // Autoplay requires muted in every evergreen browser; the stream itself
    // never carries audio (screenrecord segments are video-only here), so
    // muted costs nothing. Ignore a rejected play() — a stale/aborted
    // segment swap can reject harmlessly if a newer one lands first.
    void el.play().catch(() => {});
  }, [protocol, frameUrl]);

  if (protocol === 'h264') {
    return (
      <video
        ref={videoRef}
        className={styles.frame}
        src={frameUrl}
        muted
        playsInline
        aria-label={`${deviceName} screen`}
        {...gestures}
      />
    );
  }

  return <img className={styles.frame} src={frameUrl} alt={`${deviceName} screen`} {...gestures} />;
}

/**
 * Live device view. The connection banner is always present — guidelines §10
 * makes it non-negotiable, because a frozen last frame and a healthy stream
 * look identical without it.
 *
 * MJPEG is the default and is what "Live" means here — near-instant
 * individual frames. H264 is opt-in, not a silent upgrade: it has real
 * motion between frames within a ~2s segment, but each segment is a separate
 * round trip to the device (record, finalize, retrieve), so it runs
 * materially behind MJPEG and has a visible seam at every segment boundary.
 * See backend/src/modules/streaming/sources/adb-h264.source.ts for the full
 * reasoning — this is a real, working alternative, not a strictly better one.
 */
export function DeviceStream({ device, onGesture }: { device: Device; onGesture?: (g: StreamGesture) => void }) {
  const { user } = useAuth();
  const location = useLocation();
  const [protocol, setProtocol] = useState<StreamProtocol>('mjpeg');
  const isOffline = device.status === 'offline' || device.status === 'unreachable';
  // Opening a device's own page IS the intent to watch it, so requiring a
  // second click was pure friction. The cost that made this opt-in still
  // stands — one adb capture process per device, host CPU, a per-host cap —
  // so the expensive parts are unchanged: the grid never starts a capture
  // (its card only navigates), an offline device is never dialled, and
  // navigating away detaches the viewer exactly as before. What's gone is
  // only the extra click once a human has already asked for this device.
  const [started, setStarted] = useState(!isOffline);
  // Not gated on `user`: the hook reports 'unauthenticated' when there's no
  // token, which the banner shows as "Sign in to view". Gating here instead
  // would leave it reading "Not streaming", which wrongly implies the device
  // simply isn't being watched (the same flaw fixed in the run log viewer).
  // Streaming switched off for the org: never dial (the backend would refuse
  // with FEATURE_DISABLED anyway). Only a confirmed `false` counts; while the
  // toggles are unknown the panel behaves as before.
  const streamingOff = useFeatureDisabled('streaming');
  const { state, frameUrl, restarted, dismissRestarted, lastError, closeReason } = useDeviceStream(
    device.udid,
    !streamingOff && !isOffline && started,
    protocol,
    device.machineId,
  );

  if (streamingOff) {
    return (
      <div className={styles.wrap}>
        <div className={styles.head}>
          <span className={styles.title}>Live view</span>
          <span className={styles.banner} style={{ color: 'var(--text-tertiary)' }}>
            <span className={styles.dot} style={{ background: 'var(--text-tertiary)' }} aria-hidden="true" />
            Disabled
          </span>
        </div>
        <div className={styles.stage}>
          <div className={styles.placeholder}>
            <icons.stream size={32} aria-hidden="true" />
            <div className={styles.placeholderTitle}>Live view is disabled for your organisation</div>
            <p className={styles.placeholderBody}>
              Device streaming is switched off in the organisation config (features.streaming).
            </p>
          </div>
        </div>
      </div>
    );
  }

  // An offline device is never dialled at all, so say so directly. `!user`
  // must be checked before `!started` — the hook itself never reaches its
  // own 'unauthenticated' state while disabled (enabled = !isOffline &&
  // started, so `state` is just the hook's idle default until start is
  // clicked), and a signed-out visitor shouldn't have to click "start" to be
  // told to sign in. Only once both offline and auth are ruled out does "not
  // yet started" fall back to the same idle banner as offline/idle — the
  // stage's own button is what invites starting it from there.
  const displayState: StreamState = isOffline ? 'offline' : !user ? 'unauthenticated' : !started ? 'idle' : state;
  const banner = BANNER[displayState];

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <span className={styles.title}>Live view</span>
        <span className={styles.banner} style={{ color: banner.tone }} aria-live="polite">
          <span
            className={`${styles.dot} ${displayState === 'live' ? styles.pulse : ''}`}
            style={{ background: banner.tone }}
            aria-hidden="true"
          />
          {banner.text}
        </span>
        {/* Always visible while a capture is running, and in the header rather
            than below the fold: the stream now starts on its own, so stopping
            it must be the most obvious control on the panel. */}
        {started ? (
          <Button size="sm" variant="destructive" onClick={() => setStarted(false)}>
            <icons.cancelled size={iconSize.control} aria-hidden="true" />
            Stop live view
          </Button>
        ) : !isOffline && user ? (
          <Button size="sm" onClick={() => setStarted(true)}>
            <icons.stream size={iconSize.control} aria-hidden="true" />
            Start live view
          </Button>
        ) : null}
      </div>

      <div className={styles.protocolToggle}>
        <span>Protocol:</span>
        <button
          type="button"
          className={`${styles.protocolButton} ${protocol === 'mjpeg' ? styles.protocolButtonActive : ''}`}
          onClick={() => setProtocol('mjpeg')}
        >
          MJPEG (live)
        </button>
        <button
          type="button"
          className={`${styles.protocolButton} ${protocol === 'h264' ? styles.protocolButtonActive : ''}`}
          onClick={() => setProtocol('h264')}
          title="Experimental: the capture/relay pipeline is real and verified, but playback has only been tested against this environment's emulator, whose software encoder produced a stream Chrome could not decode — untested on real hardware. Each segment also lags a couple of seconds behind, not a live view."
        >
          H264 (experimental)
        </button>
      </div>

      {restarted ? (
        <div className={styles.restarted} role="status">
          The capture restarted — the picture may have jumped.
          <button type="button" className={styles.dismiss} onClick={dismissRestarted}>
            Dismiss
          </button>
        </div>
      ) : null}

      <div className={styles.stage}>
        {frameUrl ? (
          <StreamFrame protocol={protocol} frameUrl={frameUrl} deviceName={device.name} onGesture={onGesture} />
        ) : (
          <div className={styles.placeholder}>
            <icons.stream size={32} aria-hidden="true" />
            {!user ? (
              <>
                <div className={styles.placeholderTitle}>Sign in to watch this device</div>
                <p className={styles.placeholderBody}>
                  <Link to="/login" state={{ from: location.pathname }} className={styles.link}>
                    Sign in
                  </Link>{' '}
                  to open a live view.
                </p>
              </>
            ) : isOffline ? (
              <>
                <div className={styles.placeholderTitle}>Device is offline</div>
                <p className={styles.placeholderBody}>
                  A host must report this device before it can be streamed.
                </p>
              </>
            ) : !started ? (
              <>
                <div className={styles.placeholderTitle}>Live view stopped</div>
                <p className={styles.placeholderBody}>
                  The capture on the host was released. Start it again whenever you need it.
                </p>
                <Button size="sm" onClick={() => setStarted(true)}>
                  <icons.stream size={iconSize.control} aria-hidden="true" />
                  Start live view
                </Button>
              </>
            ) : displayState === 'rejected' ? (
              <>
                <div className={styles.placeholderTitle}>Stream unavailable</div>
                <p className={styles.placeholderBody}>{closeReason || 'The host refused the capture.'}</p>
                <Button size="sm" variant="ghost" onClick={() => setStarted(false)}>
                  Cancel
                </Button>
              </>
            ) : lastError ? (
              <>
                <div className={styles.placeholderTitle}>Last attempt failed</div>
                <p className={styles.placeholderBody}>{lastError}</p>
                <p className={styles.placeholderBody}>Retrying…</p>
              </>
            ) : (
              <>
                <div className={styles.placeholderTitle}>
                  {protocol === 'h264' ? 'Waiting for the first segment…' : 'Waiting for the first frame…'}
                </div>
                <p className={styles.placeholderBody}>
                  {protocol === 'h264'
                    ? 'The first ~2s recording is being captured on the host.'
                    : 'The capture is starting on the host.'}
                </p>
              </>
            )}
          </div>
        )}
      </div>

    </div>
  );
}

export function StreamStopButton({ device }: { device: Device }) {
  const { can } = useAuth();
  const stop = useStopDeviceStream(device.udid, device.machineId);
  // Its endpoint is a streaming route, so with streaming off it could only 404.
  const streamingOff = useFeatureDisabled('streaming');
  if (streamingOff || !can('operator', 'admin')) return null;
  return (
    <Button size="sm" variant="destructive" onClick={() => stop.mutate()} disabled={stop.isPending}>
      <icons.cancelled size={iconSize.control} aria-hidden="true" />
      {stop.isPending ? 'Stopping…' : 'Stop capture'}
    </Button>
  );
}
