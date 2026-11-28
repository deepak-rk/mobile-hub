import { formatRelative } from 'ts-format-utils';
import type { Host } from '../types';
import styles from './IdConflictNotice.module.css';

/**
 * Shown when the hub refused another machine that called in with this host's
 * machine id. That machine's agent is told why; this is so the people looking
 * at the lab find out too. The hub clears it five minutes after the last refusal.
 */
export function IdConflictNotice({ conflict }: { conflict: Host['idConflict'] }) {
  if (!conflict) return null;
  const who = conflict.hostname ? `'${conflict.hostname}'` : 'Another machine';
  return (
    <p className={styles.notice} role="status">
      {who} tried to join with this machine id {formatRelative(conflict.at)} and was refused. Give that agent its own
      MACHINE_ID.
    </p>
  );
}
