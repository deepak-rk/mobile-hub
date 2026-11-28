import { protocolState } from '../lib/hostMetrics';
import styles from './IdConflictNotice.module.css';

/**
 * Says so when this host's agent speaks a different hub <-> agent contract
 * version than the hub. Silent when they match, and when either side is too
 * old to report one (unknown is not the same as different).
 */
export function ProtocolNotice({ agent, hub }: { agent: number | null | undefined; hub: number | undefined }) {
  const state = protocolState(agent, hub);
  if (state === 'match' || state === 'unknown') return null;
  const fix = state === 'agent-older' ? 'Update the agent on this host.' : 'This agent is newer than the hub; update the hub.';
  return (
    <p className={styles.notice} role="status">
      Agent protocol {agent}, hub protocol {hub}. {fix}
    </p>
  );
}
