import { Link } from 'react-router-dom';
import {
  Button,
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
import { formatRelative, shortId } from 'ts-format-utils';
import { useDevices } from '../api/devices.api';
import { DeviceFilterBar } from '../components/DeviceFilterBar';
import { InventorySummary } from '../components/InventorySummary';
import { FilterChips } from '../components/FilterChips';
import { useDeviceFilters } from '../hooks/useDeviceFilters';
import { countBy, isOfflineStatus } from '../lib/deviceCounts';
import type { Device } from '../types';
import styles from './DevicesPage.module.css';

const CONNECTION_LABELS: Record<Device['connectionType'], string> = {
  usb: 'USB',
  network: 'Network',
  simulator: 'Simulator',
  emulator: 'Emulator',
};

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

function DeviceCard({ device }: { device: Device }) {
  return (
    <Card interactive>
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
          <span>{CONNECTION_LABELS[device.connectionType]}</span>
        </Meta>

        <LockLine device={device} />

        <div className={styles.footer}>
          <span className={styles.udid}>
            <span className={styles.footerLabel}>UDID</span>
            <Mono className={styles.udidValue}>{device.udid}</Mono>
          </span>
          <span className={styles.host}>
            <icons.host size={iconSize.dense} aria-hidden="true" />
            {device.machineId}
          </span>
        </div>

        <div className={styles.seen}>Last seen {formatRelative(device.lastSeenAt)}</div>
      </CardBody>
    </Card>
  );
}

export function DevicesPage() {
  const { status, setStatus, platform, setPlatform } = useDeviceFilters();
  const { data: devices, isPending, error, refetch } = useDevices({ status, platform });
  const filtered = status !== 'all' || platform !== 'all';

  // Only split live/offline when the user isn't already asking for offline
  // devices specifically — collapsing the very thing they filtered for would
  // hide it behind a disclosure they'd have to open right back up.
  const splitOffline = status !== 'offline' && status !== 'unreachable';
  const liveDevices = splitOffline ? (devices ?? []).filter((d) => !isOfflineStatus(d.status)) : (devices ?? []);
  const offlineDevices = splitOffline ? (devices ?? []).filter((d) => isOfflineStatus(d.status)) : [];

  return (
    <Page>
      <PageHeader
        title="Devices"
        subtitle="Every device reported by a connected host, with its current lock state."
        actions={
          <Link to="/devices/multi-view">
            <Button size="sm" variant="secondary">
              <icons.stream size={iconSize.control} aria-hidden="true" />
              Multi-view
            </Button>
          </Link>
        }
      />

      {devices && devices.length > 0 ? <InventorySummary devices={devices} /> : null}

      <DeviceFilterBar status={status} onStatusChange={setStatus} platform={platform} onPlatformChange={setPlatform} />

      {devices && devices.length > 0 ? (
        <FilterChips devices={devices} status={status} setStatus={setStatus} platform={platform} setPlatform={setPlatform} />
      ) : null}

      <QueryBoundary
        isPending={isPending}
        error={error}
        isEmpty={devices?.length === 0}
        onRetry={() => void refetch()}
        empty={
          filtered ? (
            <EmptyState
              icon={icons.device}
              title="No devices match these filters"
              body="Try a different status or platform."
              action={{
                label: 'Clear filters',
                onClick: () => {
                  setStatus('all');
                  setPlatform('all');
                },
              }}
            />
          ) : (
            <EmptyState
              icon={icons.device}
              title="No devices yet"
              body="Hosts register the devices they can see by posting to /api/devices/sync. Start an agent on a machine with a device attached and it will appear here."
            />
          )
        }
      >
        {liveDevices.length > 0 ? (
          <Grid>
            {liveDevices.map((device) => (
              <DeviceCard key={device._id} device={device} />
            ))}
          </Grid>
        ) : offlineDevices.length > 0 ? (
          <p className={styles.allOfflineNote}>No online devices right now — see offline devices below.</p>
        ) : null}

        {offlineDevices.length > 0 ? (
          <details className={styles.offlineDisclosure}>
            <summary className={styles.offlineSummary}>
              <icons.offline size={iconSize.control} aria-hidden="true" />
              {offlineDevices.length} offline device{offlineDevices.length === 1 ? '' : 's'}
            </summary>
            <Grid className={styles.offlineGrid}>
              {offlineDevices.map((device) => (
                <DeviceCard key={device._id} device={device} />
              ))}
            </Grid>
          </details>
        ) : null}

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
