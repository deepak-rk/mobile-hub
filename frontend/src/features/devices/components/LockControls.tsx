import { Link, useLocation } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import type { ApiError } from '@/components/ui/states';
import { icons, iconSize } from '@/lib/icons';
import { useAuth } from '@/features/auth/useAuth';
import { useLockDevice, useUnlockDevice } from '../api/devices.api';
import type { Device } from '../types';
import styles from './LockControls.module.css';

/**
 * Lock/unlock for one device. Actions are hidden rather than disabled when the
 * caller can't perform them (guidelines §14: unauthorized → hide by role), so
 * nobody clicks a button that can only 401.
 */
export function LockControls({ device }: { device: Device }) {
  const { user } = useAuth();
  const location = useLocation();
  const lock = useLockDevice(device.udid);
  const unlock = useUnlockDevice(device.udid);

  if (!user) {
    return (
      <p className={styles.signedOut}>
        <Link to="/login" state={{ from: location.pathname }} className={styles.link}>
          Sign in
        </Link>{' '}
        to lock this device.
      </p>
    );
  }

  const isOffline = device.status === 'offline' || device.status === 'unreachable';
  if (isOffline) {
    return <p className={styles.signedOut}>Device is offline — it cannot be locked until a host reports it again.</p>;
  }

  const heldByMe = device.lock?.heldBy === user.id;
  const canForceUnlock = user.role === 'admin';
  const pending = lock.isPending || unlock.isPending;
  const error = (lock.error ?? unlock.error) as ApiError | null;

  return (
    <div className={styles.wrap}>
      <div className={styles.actions}>
        {device.lock ? (
          heldByMe || canForceUnlock ? (
            <Button size="sm" onClick={() => unlock.mutate()} disabled={pending}>
              <icons.unlocked size={iconSize.control} aria-hidden="true" />
              {heldByMe ? 'Release lock' : 'Force unlock'}
            </Button>
          ) : (
            <span className={styles.note}>Locked by someone else. An admin can force-release it.</span>
          )
        ) : (
          <Button size="sm" variant="primary" onClick={() => lock.mutate(undefined)} disabled={pending}>
            <icons.locked size={iconSize.control} aria-hidden="true" />
            Lock device
          </Button>
        )}
      </div>

      {error ? (
        <p className={styles.error} role="alert">
          {error.message ?? 'The action failed.'}
        </p>
      ) : null}
    </div>
  );
}
