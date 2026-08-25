import { Card, CardBody, Grid, Meta, MetaSep, Mono, Page, PageHeader, Summary } from '@/components/ui/layout';
import { QueryBoundary, EmptyState } from '@/components/ui/states';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { icons, iconSize } from '@/lib/icons';
import { formatRelative } from '@/lib/format';
import { useHosts } from '../api/hosts.api';
import styles from './ServersPage.module.css';

const OS_LABEL: Record<string, string> = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' };

export function ServersPage() {
  const { data: hosts, isPending, error, refetch } = useHosts();

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
