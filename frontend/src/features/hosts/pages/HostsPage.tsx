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
  ProgressBar,
  QueryBoundary,
  Summary,
} from 'react-design-kit';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { icons, iconSize } from '@/lib/icons';
import { useAuth } from '@/features/auth/useAuth';
import { formatBytes, formatRelative } from 'ts-format-utils';
import { useHosts, useHostCredentials } from '../api/hosts.api';
import { credentialFor } from '../lib/credentialFor';
import { HostBlockControl } from '../components/HostBlockControl';
import { IdConflictNotice } from '../components/IdConflictNotice';
import type { Host, HostAgentCredential } from '../types';
import styles from './HostsPage.module.css';

const OS_LABEL: Record<string, string> = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' };

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** Live counts as chips — only ever shows what's actually non-zero, so an idle host renders no row at all. */
function ActivityChips({ activity }: { activity: Host['activity'] }) {
  const chips = [
    activity.runs > 0 ? pluralize(activity.runs, 'run') : null,
    activity.streams > 0 ? pluralize(activity.streams, 'stream') : null,
    activity.installs > 0 ? pluralize(activity.installs, 'install') : null,
    activity.uninstalls > 0 ? pluralize(activity.uninstalls, 'uninstall') : null,
  ].filter((c): c is string => c !== null);

  if (chips.length === 0) return null;

  return (
    <div className={styles.platforms}>
      {chips.map((chip) => (
        <span key={chip} className={styles.chip}>
          {chip}
        </span>
      ))}
    </div>
  );
}

/** Best-effort host stats — absent entirely for an agent that predates this field. */
function DiagnosticsPanel({ diagnostics }: { diagnostics: Host['diagnostics'] }) {
  if (!diagnostics) return null;

  const { diskFreeBytes, diskTotalBytes, nodeVersion } = diagnostics;
  const diskUsedPercent =
    diskFreeBytes !== null && diskTotalBytes !== null && diskTotalBytes > 0
      ? ((diskTotalBytes - diskFreeBytes) / diskTotalBytes) * 100
      : null;

  return (
    <div className={styles.diagnostics}>
      {nodeVersion !== null ? (
        <Meta>
          <span>Node {nodeVersion}</span>
        </Meta>
      ) : null}
      {diskUsedPercent !== null ? (
        <ProgressBar
          value={diskUsedPercent}
          label={`${formatBytes(diskFreeBytes)} free of ${formatBytes(diskTotalBytes)}`}
        />
      ) : null}
    </div>
  );
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
                  <StatusBadge status={host.blocked ? 'blocked' : host.status} />
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

                <IdConflictNotice conflict={host.idConflict ?? null} />
                <ActivityChips activity={host.activity} />
                <DiagnosticsPanel diagnostics={host.diagnostics} />

                {isAdmin ? <CredentialHealth credentials={credentials} machineId={host.machineId} /> : null}
                {isAdmin ? <HostBlockControl host={host} /> : null}

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
