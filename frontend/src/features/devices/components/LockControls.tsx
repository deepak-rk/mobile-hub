import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Button, Dialog, useToast } from 'react-design-kit';
import type { ApiError } from '@/services/api';
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
  const { show } = useToast();
  const lock = useLockDevice(device.udid);
  const unlock = useUnlockDevice(device.udid);
  const [confirmForceUnlock, setConfirmForceUnlock] = useState(false);

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

  function doLock() {
    lock.mutate(undefined, {
      onSuccess: () => show(`${device.name} locked`, { tone: 'success' }),
      onError: () => show(`Failed to lock ${device.name}`, { tone: 'danger' }),
    });
  }

  function doUnlock() {
    unlock.mutate(undefined, {
      onSuccess: () => show(heldByMe ? `${device.name} released` : `${device.name} force-unlocked`, { tone: 'success' }),
      onError: () => show(`Failed to release ${device.name}`, { tone: 'danger' }),
    });
  }

  function onReleaseClick() {
    // Releasing your own lock is routine and reversible (lock it again any
    // time) — no confirmation needed. Force-releasing someone ELSE's lock
    // affects a session you don't own and can interrupt their work, so it
    // gets a real confirm step rather than firing on a single click.
    if (heldByMe) {
      doUnlock();
    } else {
      setConfirmForceUnlock(true);
    }
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.actions}>
        {device.lock ? (
          heldByMe || canForceUnlock ? (
            <Button size="sm" onClick={onReleaseClick} disabled={pending}>
              <icons.unlocked size={iconSize.control} aria-hidden="true" />
              {heldByMe ? 'Release lock' : 'Force unlock'}
            </Button>
          ) : (
            <span className={styles.note}>Locked by someone else. An admin can force-release it.</span>
          )
        ) : (
          <Button size="sm" variant="primary" onClick={doLock} disabled={pending}>
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

      <Dialog
        open={confirmForceUnlock}
        onClose={() => setConfirmForceUnlock(false)}
        title="Force unlock this device?"
        actions={
          <>
            <Button size="sm" variant="ghost" onClick={() => setConfirmForceUnlock(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => {
                setConfirmForceUnlock(false);
                doUnlock();
              }}
            >
              Force unlock
            </Button>
          </>
        }
      >
        {device.lock ? (
          <>
            Currently held by <strong>{device.lock.heldBy}</strong>
            {device.lock.reason ? ` (${device.lock.reason})` : ''}. Releasing it now may interrupt whatever they&rsquo;re
            doing with this device.
          </>
        ) : (
          'This will release the current lock.'
        )}
      </Dialog>
    </div>
  );
}
