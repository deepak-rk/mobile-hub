import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Button } from 'react-design-kit';
import { icons, iconSize } from '@/lib/icons';
import { useAuth } from '@/features/auth/useAuth';
import { useDeviceStream, type StreamProtocol, type StreamState } from '../api/useDeviceStream';
import { useStopDeviceStream } from '../api/devices.api';
import type { Device } from '../types';
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
function StreamFrame({
  protocol,
  frameUrl,
  deviceName,
}: {
  protocol: StreamProtocol;
  frameUrl: string;
  deviceName: string;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

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
      />
    );
  }

  return <img className={styles.frame} src={frameUrl} alt={`${deviceName} screen`} />;
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
export function DeviceStream({ device }: { device: Device }) {
  const { user } = useAuth();
  const location = useLocation();
  const [protocol, setProtocol] = useState<StreamProtocol>('mjpeg');
  // The capture only starts on the host once a viewer actually attaches
  // (streaming.service.ts's whole design), but the WS itself used to open
  // the instant this page loaded — watching a device was never something a
  // visitor opted into. Gating it behind a click matches that backend
  // invariant on the frontend too, and avoids spending a capture slot (see
  // the per-host Android stream cap) on a tab nobody is actually looking at.
  const [started, setStarted] = useState(false);
  const isOffline = device.status === 'offline' || device.status === 'unreachable';
  // Not gated on `user`: the hook reports 'unauthenticated' when there's no
  // token, which the banner shows as "Sign in to view". Gating here instead
  // would leave it reading "Not streaming", which wrongly implies the device
  // simply isn't being watched (the same flaw fixed in the run log viewer).
  const { state, frameUrl, restarted, dismissRestarted, lastError, closeReason } = useDeviceStream(
    device.udid,
    !isOffline && started,
    protocol,
  );

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
          <StreamFrame protocol={protocol} frameUrl={frameUrl} deviceName={device.name} />
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
                <div className={styles.placeholderTitle}>Live view is off</div>
                <p className={styles.placeholderBody}>
                  Starts a capture on the host — nothing is spent watching a page nobody has opened this on.
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

      {started ? (
        <Button size="sm" variant="ghost" onClick={() => setStarted(false)} className={styles.stopWatching}>
          Stop watching
        </Button>
      ) : null}
    </div>
  );
}

export function StreamStopButton({ device }: { device: Device }) {
  const { can } = useAuth();
  const stop = useStopDeviceStream(device.udid);
  if (!can('operator', 'admin')) return null;
  return (
    <Button size="sm" variant="destructive" onClick={() => stop.mutate()} disabled={stop.isPending}>
      <icons.cancelled size={iconSize.control} aria-hidden="true" />
      {stop.isPending ? 'Stopping…' : 'Stop capture'}
    </Button>
  );
}
