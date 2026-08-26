import { Link } from 'react-router-dom';
import {
  Card,
  CardBody,
  Grid,
  Meta,
  MetaSep,
  Mono,
  Page,
  PageHeader,
  Summary,
} from '@/components/ui/layout';
import { QueryBoundary, EmptyState } from '@/components/ui/states';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { icons, iconSize } from '@/lib/icons';
import { formatRelative, shortId } from 'ts-format-utils';
import { useDevices } from '../api/devices.api';
import type { Device } from '../types';
import styles from './DevicesPage.module.css';

function countBy(devices: Device[] | undefined, status: Device['status']): number {
  return devices?.filter((d) => d.status === status).length ?? 0;
}

/**
 * Execution locks carry a reason of `execution:<runId>`. Surfacing that raw
 * string crowds the card with an opaque id, so it becomes a link to the run
 * instead; anything else is shown as-is since a human wrote it.
 */
function LockLine({ device }: { device: Device }) {
  if (!device.lock) return null;
  const reason = device.lock.reason ?? '';
  const runId = reason.startsWith('execution:') ? reason.slice('execution:'.length) : null;

  return (
    <div className={styles.lock}>
      <icons.locked size={iconSize.dense} aria-hidden="true" />
      {runId ? (
        <span>
          Held by run{' '}
          <Link to={`/execution/${runId}`} className={styles.lockLink}>
            {shortId(runId)}
          </Link>
        </span>
      ) : (
        <span>Held{reason ? ` · ${reason}` : ''}</span>
      )}
    </div>
  );
}

export function DevicesPage() {
  const { data: devices, isPending, error, refetch } = useDevices();

  return (
    <Page>
      <PageHeader
        title="Devices"
        subtitle="Every device reported by a connected host, with its current lock state."
      />

      <QueryBoundary
        isPending={isPending}
        error={error}
        isEmpty={devices?.length === 0}
        onRetry={() => void refetch()}
        empty={
          <EmptyState
            icon={icons.device}
            title="No devices yet"
            body="Hosts register the devices they can see by posting to /api/devices/sync. Start an agent on a machine with a device attached and it will appear here."
          />
        }
      >
        <Grid>
          {devices?.map((device) => (
            <Card key={device._id} interactive>
              <CardBody>
                <div className={styles.head}>
                  <span className={styles.deviceIcon}>
                    <icons.device size={iconSize.control} aria-hidden="true" />
                  </span>
                  <Link to={`/devices/${device.udid}`} className={styles.name}>
                    {device.name}
                  </Link>
                  <StatusBadge status={device.status} />
                </div>

                <Meta>
                  <span>
                    {device.platform === 'ios' ? 'iOS' : 'Android'} {device.osVersion}
                  </span>
                  <MetaSep />
                  <span>{device.model}</span>
                  <MetaSep />
                  <span>{device.connectionType}</span>
                </Meta>

                <LockLine device={device} />

                <div className={styles.footer}>
                  <Mono>{device.udid}</Mono>
                  <span className={styles.host}>
                    <icons.host size={iconSize.dense} aria-hidden="true" />
                    {device.machineId}
                  </span>
                </div>

                <div className={styles.seen}>Last seen {formatRelative(device.lastSeenAt)}</div>
              </CardBody>
            </Card>
          ))}
        </Grid>

        {devices && devices.length > 0 ? (
          <Summary
            items={[
              { label: 'total', value: devices.length },
              { label: 'idle', value: countBy(devices, 'idle') },
              { label: 'in use', value: countBy(devices, 'in-use') },
              { label: 'offline', value: countBy(devices, 'offline') },
            ]}
          />
        ) : null}
      </QueryBoundary>
    </Page>
  );
}
