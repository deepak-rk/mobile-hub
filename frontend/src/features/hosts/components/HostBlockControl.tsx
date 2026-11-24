import { useState } from 'react';
import { Button, Dialog } from 'react-design-kit';
import { formatRelative } from 'ts-format-utils';
import type { ApiError } from '@/services/api';
import { useSetHostBlocked } from '../api/hosts.api';
import type { Host } from '../types';
import styles from './HostBlockControl.module.css';

/**
 * Admin-only: remove a host from the lab, or let it back in. Removal sticks:
 * the hub refuses the host's agent until it is unblocked, rather than letting
 * the next heartbeat re-register it.
 */
export function HostBlockControl({ host }: { host: Host }) {
  const setBlocked = useSetHostBlocked(host.machineId);
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const error = setBlocked.error as ApiError | null;

  if (host.blocked) {
    return (
      <div className={styles.wrap}>
        <p className={styles.note}>
          Removed {formatRelative(host.blocked.at)}
          {host.blocked.reason ? ` — ${host.blocked.reason}` : ''}. Its agent is refused until it is let back in.
        </p>
        <Button size="sm" variant="secondary" disabled={setBlocked.isPending} onClick={() => setBlocked.mutate({ blocked: false })}>
          Let back in
        </Button>
        {error ? (
          <p className={styles.error} role="alert">
            {error.message ?? 'The action failed.'}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className={styles.wrap}>
      <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
        Remove from lab
      </Button>
      {error ? (
        <p className={styles.error} role="alert">
          {error.message ?? 'The action failed.'}
        </p>
      ) : null}
      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title={`Remove ${host.hostname} from the lab?`}
        actions={
          <>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={setBlocked.isPending}
              onClick={() => {
                setConfirming(false);
                setBlocked.mutate({ blocked: true, reason: reason.trim() || undefined });
              }}
            >
              Remove
            </Button>
          </>
        }
      >
        <p className={styles.body}>
          Its devices go offline and their locks are released, its queued and running installs fail, and its device
          actions stop. Its agent is refused until you let the host back in.
        </p>
        <label className={styles.label} htmlFor={`block-reason-${host.machineId}`}>
          Reason (optional)
        </label>
        <input
          id={`block-reason-${host.machineId}`}
          className={styles.input}
          value={reason}
          maxLength={500}
          onChange={(e) => setReason(e.target.value)}
        />
      </Dialog>
    </div>
  );
}
