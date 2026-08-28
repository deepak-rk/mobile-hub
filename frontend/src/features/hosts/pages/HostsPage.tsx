import {
  Card,
  CardBody,
  EmptyState,
  Grid,
  Meta,
  MetaSep,
  Mono,
  Page,
  PageHeader,
  QueryBoundary,
  Summary,
} from 'react-design-kit';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { icons, iconSize } from '@/lib/icons';
import { useAuth } from '@/features/auth/useAuth';
import { formatRelative } from 'ts-format-utils';
import { useHosts, useHostCredentials } from '../api/hosts.api';
import type { HostAgentCredential } from '../types';
import styles from './HostsPage.module.css';

const OS_LABEL: Record<string, string> = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' };

/**
 * Picks the credential to surface for a host: the active one if it has one,
 * otherwise its most recent (the list arrives sorted `createdAt` desc, same
 * order the agent-credentials page renders it in). `undefined` means "don't
 * know yet" (still loading, or never fetched because the viewer isn't an
 * admin) — distinct from `null`, which means "fetched, and there truly is no
 * dedicated credential for this machineId" (the agent falls back to the
 * shared `AGENT_TOKEN`).
 */
function credentialFor(
  credentials: HostAgentCredential[] | undefined,
  machineId: string,
): HostAgentCredential | null | undefined {
  if (!credentials) return undefined;
  const matches = credentials.filter((c) => c.machineId === machineId);
  if (matches.length === 0) return null;
  return matches.find((c) => !c.revokedAt) ?? matches[0];
}

/** Admin-only row — only ever rendered behind a `can('admin')` check. */
function CredentialHealth({ credentials, machineId }: { credentials: HostAgentCredential[] | undefined; machineId: string }) {
  const cred = credentialFor(credentials, machineId);

  if (cred === undefined) return null;

  if (cred === null) {
    return (
      <div className={styles.credentialRow}>
        <span className={styles.noCredential}>
          <icons.credential size={iconSize.dense} aria-hidden="true" />
          Shared token (no dedicated credential)
        </span>
      </div>
    );
  }

  return (
    <div className={styles.credentialRow}>
      <StatusBadge status={cred.revokedAt ? 'revoked' : 'active'} bare />
      <span className={styles.credentialLabel}>{cred.label ?? `issued ${formatRelative(cred.createdAt)}`}</span>
    </div>
  );
}

export function HostsPage() {
  const { can } = useAuth();
  const isAdmin = can('admin');
  const { data: hosts, isPending, error, refetch } = useHosts();
  // Admin-only on the backend, same restriction the agent-credentials page
  // enforces — `enabled: isAdmin` keeps this from ever being requested for a
  // signed-out or non-admin visitor.
  const { data: credentials } = useHostCredentials(isAdmin);

  return (
    <Page>
      <PageHeader
        title="Hosts"
        subtitle="Machines running a Mobile Hub agent. A host that stops sending heartbeats is marked offline automatically."
      />

      <QueryBoundary
        isPending={isPending}
        error={error}
        isEmpty={hosts?.length === 0}
        onRetry={() => void refetch()}
        empty={
          <EmptyState
            icon={icons.host}
            title="No hosts registered"
            body="Agents register themselves by posting a heartbeat to /api/hosts/heartbeat. Start an agent and it will appear here within a few seconds."
          />
        }
      >
        <Grid>
          {hosts?.map((host) => (
            <Card key={host._id}>
              <CardBody>
                <div className={styles.head}>
                  <span className={styles.hostIcon}>
                    <icons.host size={iconSize.control} aria-hidden="true" />
                  </span>
                  <span className={styles.name}>{host.hostname}</span>
                  <StatusBadge status={host.status} />
                </div>

                <Meta>
                  <span>{OS_LABEL[host.os] ?? host.os}</span>
                  <MetaSep />
                  <span>agent {host.agentVersion}</span>
                  <MetaSep />
                  <span>max {host.capabilities.maxDevices} devices</span>
                </Meta>

                <div className={styles.platforms}>
                  {host.capabilities.androidSupport ? <span className={styles.chip}>Android</span> : null}
                  {host.capabilities.iosSupport ? <span className={styles.chip}>iOS</span> : null}
                </div>

                {isAdmin ? <CredentialHealth credentials={credentials} machineId={host.machineId} /> : null}

                <div className={styles.footer}>
                  <Mono>{host.machineId}</Mono>
                  <span className={styles.seen}>Heartbeat {formatRelative(host.lastHeartbeatAt)}</span>
                </div>
              </CardBody>
            </Card>
          ))}
        </Grid>

        {hosts && hosts.length > 0 ? (
          <Summary
            items={[
              { label: 'hosts', value: hosts.length },
              { label: 'online', value: hosts.filter((h) => h.status === 'online').length },
              { label: 'offline', value: hosts.filter((h) => h.status === 'offline').length },
            ]}
          />
        ) : null}
      </QueryBoundary>
    </Page>
  );
}
