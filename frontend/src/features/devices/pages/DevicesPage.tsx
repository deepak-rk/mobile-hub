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
import { useDeviceFilters } from '../hooks/useDeviceFilters';
import type { Device } from '../types';
import styles from './DevicesPage.module.css';

const CONNECTION_LABELS: Record<Device['connectionType'], string> = {
  usb: 'USB',
  network: 'Network',
  simulator: 'Simulator',
  emulator: 'Emulator',
};

function countBy(devices: Device[] | undefined, status: Device['status']): number {
  return devices?.filter((d) => d.status === status).length ?? 0;
}

/** A device is "offline" for grouping/collapse purposes if it's unreachable either way — the two statuses read the same to an operator. */
function isOfflineStatus(status: Device['status']): boolean {
  return status === 'offline' || status === 'unreachable';
}

function countOnline(devices: Device[] | undefined): number {
  return devices?.filter((d) => !isOfflineStatus(d.status)).length ?? 0;
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

/**
 * A scan line above the grid: at-a-glance totals for the current view.
 * "Online" is broader than any single status — everything that isn't
 * offline/unreachable — so it's computed here rather than reusing a status
 * filter value. Deliberately reads whatever `devices` the page already
 * fetched (guidelines: no extra request just for a summary row).
 */
function InventorySummary({ devices }: { devices: Device[] }) {
  const items: { key: string; label: string; value: number; icon: (typeof icons)[keyof typeof icons]; tone: string }[] = [
    { key: 'total', label: 'total', value: devices.length, icon: icons.device, tone: 'var(--text-tertiary)' },
    { key: 'online', label: 'online', value: countOnline(devices), icon: icons.dot, tone: 'var(--status-idle)' },
    { key: 'in-use', label: 'in use', value: countBy(devices, 'in-use'), icon: icons.locked, tone: 'var(--status-in-use)' },
    {
      key: 'offline',
      label: 'offline',
      value: countBy(devices, 'offline') + countBy(devices, 'unreachable'),
      icon: icons.offline,
      tone: 'var(--status-offline)',
    },
  ];

  return (
    <div className={styles.inventory} role="group" aria-label="Device inventory summary">
      {items.map((item) => (
        <span key={item.key} className={styles.inventoryItem}>
          <item.icon size={iconSize.dense} aria-hidden="true" style={{ color: item.tone }} />
          <span className={styles.inventoryValue}>{item.value}</span>
          <span className={styles.inventoryLabel}>{item.label}</span>
        </span>
      ))}
    </div>
  );
}

/**
 * Quick-filter chips bound to the same URL-synced state `DeviceFilterBar`
 * uses — not a second filter mechanism, just a faster, count-bearing way to
 * hit the same status/platform values the dropdowns already expose. Counts
 * come from the already-fetched (possibly already-filtered) `devices` list,
 * so a chip's number reflects the current view, not a separate global fetch.
 */
function FilterChips({
  devices,
  status,
  setStatus,
  platform,
  setPlatform,
}: {
  devices: Device[];
  status: ReturnType<typeof useDeviceFilters>['status'];
  setStatus: ReturnType<typeof useDeviceFilters>['setStatus'];
  platform: ReturnType<typeof useDeviceFilters>['platform'];
  setPlatform: ReturnType<typeof useDeviceFilters>['setPlatform'];
}) {
  const chips = [
    {
      key: 'all',
      label: 'All',
      count: devices.length,
      active: status === 'all' && platform === 'all',
      onClick: () => {
        setStatus('all');
        setPlatform('all');
      },
    },
    {
      key: 'idle',
      label: 'Idle',
      count: countBy(devices, 'idle'),
      active: status === 'idle',
      onClick: () => setStatus(status === 'idle' ? 'all' : 'idle'),
    },
    {
      key: 'in-use',
      label: 'In use',
      count: countBy(devices, 'in-use'),
      active: status === 'in-use',
      onClick: () => setStatus(status === 'in-use' ? 'all' : 'in-use'),
    },
    {
      key: 'offline',
      label: 'Offline',
      count: countBy(devices, 'offline'),
      active: status === 'offline',
      onClick: () => setStatus(status === 'offline' ? 'all' : 'offline'),
    },
    {
      key: 'android',
      label: 'Android',
      count: devices.filter((d) => d.platform === 'android').length,
      active: platform === 'android',
      onClick: () => setPlatform(platform === 'android' ? 'all' : 'android'),
    },
    {
      key: 'ios',
      label: 'iOS',
      count: devices.filter((d) => d.platform === 'ios').length,
      active: platform === 'ios',
      onClick: () => setPlatform(platform === 'ios' ? 'all' : 'ios'),
    },
  ];

  return (
    <div className={styles.chipRow} role="group" aria-label="Quick filters">
      {chips.map((chip) => (
        <button
          key={chip.key}
          type="button"
          className={`${styles.chip} ${chip.active ? styles.chipActive : ''}`}
          onClick={chip.onClick}
          aria-pressed={chip.active}
        >
          {chip.label} <span className={styles.chipCount}>{chip.count}</span>
        </button>
      ))}
    </div>
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
