import { Link } from 'react-router-dom';
import { icons, iconSize } from '@/lib/icons';
import { useDeviceStream, type StreamState } from '../api/useDeviceStream';
import type { Device } from '../types';
import styles from './MultiViewTile.module.css';

const TONE: Record<StreamState, string> = {
  idle: 'var(--text-tertiary)',
  connecting: 'var(--status-running)',
  live: 'var(--status-idle)',
  reconnecting: 'var(--status-smoke)',
  offline: 'var(--status-offline)',
  unauthenticated: 'var(--text-tertiary)',
  rejected: 'var(--status-failed)',
};

/**
 * One tile in the multi-device grid. Deliberately not `DeviceStream` reused
 * wholesale — that component is built for a single full-page viewer
 * (protocol toggle, restart banner, big stage); a grid tile is small and
 * always MJPEG (the only protocol that's actually live, not experimental).
 * Being selected into the grid *is* the "start watching" gesture here, so
 * unlike the single-device page this connects immediately, no button gate.
 */
export function MultiViewTile({ device, onRemove }: { device: Device; onRemove: () => void }) {
  const isOffline = device.status === 'offline' || device.status === 'unreachable';
  const { state, frameUrl } = useDeviceStream(device.udid, !isOffline, 'mjpeg');
  const displayState: StreamState = isOffline ? 'offline' : state;

  return (
    <div className={styles.tile}>
      <div className={styles.head}>
        <Link to={`/devices/${device.udid}`} className={styles.name}>
          {device.name}
        </Link>
        <span className={styles.dot} style={{ background: TONE[displayState] }} aria-hidden="true" />
        <button type="button" className={styles.remove} onClick={onRemove} aria-label={`Stop watching ${device.name}`}>
          ×
        </button>
      </div>
      <div className={styles.stage}>
        {frameUrl ? (
          <img className={styles.frame} src={frameUrl} alt={`${device.name} screen`} />
        ) : (
          <div className={styles.placeholder}>
            <icons.stream size={iconSize.empty} aria-hidden="true" />
            <span>{isOffline ? 'Offline' : displayState === 'rejected' ? 'Unavailable' : 'Connecting…'}</span>
          </div>
        )}
      </div>
    </div>
  );
}
