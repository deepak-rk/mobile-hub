import { Link, useLocation } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { icons, iconSize } from '@/lib/icons';
import { useAuth } from '@/features/auth/useAuth';
import { useDeviceStream, type StreamState } from '../api/useDeviceStream';
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
 * Live device view. The connection banner is always present — guidelines §10
 * makes it non-negotiable, because a frozen last frame and a healthy stream
 * look identical without it.
 */
export function DeviceStream({ device }: { device: Device }) {
  const { user } = useAuth();
  const location = useLocation();
  const isOffline = device.status === 'offline' || device.status === 'unreachable';
  // Not gated on `user`: the hook reports 'unauthenticated' when there's no
  // token, which the banner shows as "Sign in to view". Gating here instead
  // would leave it reading "Not streaming", which wrongly implies the device
  // simply isn't being watched (the same flaw fixed in the run log viewer).
  const { state, frameUrl, restarted, dismissRestarted } = useDeviceStream(device.udid, !isOffline);

  // An offline device is never dialled at all, so say so directly.
  const displayState: StreamState = isOffline ? 'offline' : state;
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
          <img className={styles.frame} src={frameUrl} alt={`${device.name} screen`} />
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
            ) : displayState === 'rejected' ? (
              <>
                <div className={styles.placeholderTitle}>Stream unavailable</div>
                <p className={styles.placeholderBody}>
                  The host refused the capture. It may be at its concurrent-stream limit.
                </p>
              </>
            ) : (
              <>
                <div className={styles.placeholderTitle}>Waiting for the first frame…</div>
                <p className={styles.placeholderBody}>The capture is starting on the host.</p>
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
  const stop = useStopDeviceStream(device.udid);
  if (!can('operator', 'admin')) return null;
  return (
    <Button size="sm" variant="destructive" onClick={() => stop.mutate()} disabled={stop.isPending}>
      <icons.cancelled size={iconSize.control} aria-hidden="true" />
      {stop.isPending ? 'Stopping…' : 'Stop capture'}
    </Button>
  );
}
