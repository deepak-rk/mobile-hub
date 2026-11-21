import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
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
} from 'react-design-kit';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { icons, iconSize } from '@/lib/icons';
import { formatRelative, shortId } from 'ts-format-utils';
import { useDevices } from '../api/devices.api';
import { DeviceFilterBar } from '../components/DeviceFilterBar';
import { FilterChips } from '../components/FilterChips';
import { useDeviceFilters } from '../hooks/useDeviceFilters';
import { MULTI_VIEW_MAX } from '../hooks/useMultiViewSelection';
import { isOfflineStatus } from '../lib/deviceCounts';
import { displayModel } from '../lib/deviceLabels';
import { deviceHref, deviceKey } from '../lib/deviceKey';
import type { Device } from '../types';
import styles from './DevicesPage.module.css';

const CONNECTION_LABELS: Record<Device['connectionType'], string> = {
  usb: 'USB',
  network: 'Network',
  simulator: 'Simulator',
  emulator: 'Emulator',
};

/** Multi-view is only meaningful with something to compare against. */
const MULTI_VIEW_MIN = 2;

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

/** Exported for `DeviceCard.test.tsx` — the multi-view "View live" regression. */
export function DeviceCard({
  device,
  selectable,
  selected,
  selectionFull,
  onToggle,
}: {
  device: Device;
  selectable: boolean;
  selected: boolean;
  selectionFull: boolean;
  /** Called with `deviceKey(device)` (host + udid), not the bare udid. */
  onToggle: (key: string) => void;
}) {
  const offline = isOfflineStatus(device.status);
  const model = displayModel(device);
  // Offline devices can't be captured at all, so they're never selectable and
  // never offered a live action — the backend would refuse either way.
  const disabled = selectable && offline;

  const body = (
    <CardBody>
      <div className={styles.head}>
        {selectable ? (
          <input
            type="checkbox"
            className={styles.selectBox}
            checked={selected}
            disabled={disabled || (!selected && selectionFull)}
            onChange={() => onToggle(deviceKey(device))}
            aria-label={`Select ${device.name} for multi-view`}
          />
        ) : (
          <span className={styles.deviceIcon}>
            <icons.device size={iconSize.control} aria-hidden="true" />
          </span>
        )}
        {selectable ? (
          <span className={styles.name}>{device.name}</span>
        ) : (
          <Link to={deviceHref(device.udid, device.machineId)} className={styles.name}>
            {device.name}
          </Link>
        )}
        {/* An install holds no lock, so `status` stays idle through one —
            shown alongside rather than replacing it, because both are true
            at once and the device really is unlocked. */}
        {device.activeInstall ? <StatusBadge status="installing" /> : null}
        <StatusBadge status={device.status} />
      </div>

      <Meta>
        <span>
          {device.platform === 'ios' ? 'iOS' : 'Android'} {device.osVersion}
        </span>
        {/* Suppressed for emulators, whose "model" is a system-image id that
            repeats nothing useful next to the name. */}
        {model ? (
          <>
            <MetaSep />
            <span>{model}</span>
          </>
        ) : null}
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

      <div className={styles.cardFooterRow}>
        <span className={styles.seen}>Last seen {formatRelative(device.lastSeenAt)}</span>
        {/* An explicit, labelled action: the whole card being a link to the
            viewer was not discoverable. Navigation only — the viewer page
            decides whether to open a capture, so the grid never starts one.
            Kept available during multi-view picking too — hiding it there
            left no way to view a single device at all until 2+ were selected
            (or the picker was cancelled first). Picking mode wraps the whole
            card body in a <label> bound to the checkbox, so a bare click here
            would *also* toggle selection via the browser's default label
            forwarding; stopPropagation keeps this link's click just a link. */}
        {!offline ? (
          <Link
            to={deviceHref(device.udid, device.machineId)}
            className={styles.liveAction}
            onClick={(e) => selectable && e.stopPropagation()}
          >
            <Button size="sm" variant="secondary">
              <icons.stream size={iconSize.control} aria-hidden="true" />
              View live
            </Button>
          </Link>
        ) : null}
      </div>
    </CardBody>
  );

  if (!selectable) return <Card interactive>{body}</Card>;

  return (
    <Card className={selected ? styles.cardSelected : undefined}>
      <label className={`${styles.selectLabel} ${disabled ? styles.selectLabelDisabled : ''}`}>{body}</label>
    </Card>
  );
}

export function DevicesPage() {
  const navigate = useNavigate();
  const { status, setStatus, platform, setPlatform } = useDeviceFilters();
  const { data: devices, isPending, error, refetch } = useDevices({ status, platform });
  const filtered = status !== 'all' || platform !== 'all';
  // Chip counts come from the *unfiltered* inventory: counting the
  // server-filtered list made every other chip read 0 (status=idle showed
  // "Offline 0" whatever the real number). Same query as the unfiltered
  // list, so with no filter active this is one request, not two.
  const { data: allDevices } = useDevices();

  // Selection lives here rather than in the URL: the multi-view *page* owns
  // the `udids` param, and mirroring it while still picking would leave two
  // writers for one piece of state.
  const [picking, setPicking] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);

  // Holds deviceKey()s (host + udid): emulator serials repeat across hosts.
  function toggle(key: string) {
    setSelected((prev) =>
      prev.includes(key)
        ? prev.filter((k) => k !== key)
        : prev.length < MULTI_VIEW_MAX
          ? [...prev, key]
          : prev,
    );
  }

  function cancelPicking() {
    setPicking(false);
    setSelected([]);
  }

  // Only split live/offline when the user isn't already asking for offline
  // devices specifically — collapsing the very thing they filtered for would
  // hide it behind a disclosure they'd have to open right back up.
  const splitOffline = status !== 'offline' && status !== 'unreachable';
  const liveDevices = splitOffline ? (devices ?? []).filter((d) => !isOfflineStatus(d.status)) : (devices ?? []);
  const offlineDevices = splitOffline ? (devices ?? []).filter((d) => isOfflineStatus(d.status)) : [];

  const cardProps = {
    selectable: picking,
    selectionFull: selected.length >= MULTI_VIEW_MAX,
    onToggle: toggle,
  };

  return (
    <Page>
      <PageHeader
        title="Devices"
        subtitle="Every device reported by a connected host, with its current lock state."
      />

      {/* One control row: the chips already carry per-status counts and are
          actionable, so a separate summary strip above them was the same
          numbers twice and pushed the grid below the fold. Multi-view sits
          here rather than in the page header because it acts on this list. */}
      <div className={styles.toolbar}>
        {allDevices && allDevices.length > 0 ? (
          <FilterChips
            devices={allDevices}
            status={status}
            setStatus={setStatus}
            platform={platform}
            setPlatform={setPlatform}
          />
        ) : (
          <span />
        )}
        <div className={styles.toolbarRight}>
          <DeviceFilterBar
            status={status}
            onStatusChange={setStatus}
            platform={platform}
            onPlatformChange={setPlatform}
          />
          {picking ? (
            <Button size="sm" variant="ghost" onClick={cancelPicking}>
              Cancel
            </Button>
          ) : (
            <Button size="sm" variant="secondary" onClick={() => setPicking(true)}>
              <icons.stream size={iconSize.control} aria-hidden="true" />
              Multi-view
            </Button>
          )}
        </div>
      </div>

      {picking ? (
        <div className={styles.pickBar} role="status">
          <span className={styles.pickHint}>
            Select {MULTI_VIEW_MIN}–{MULTI_VIEW_MAX} online devices · {selected.length}/{MULTI_VIEW_MAX} selected
          </span>
          <Button
            size="sm"
            disabled={selected.length < MULTI_VIEW_MIN}
            onClick={() => navigate(`/devices/multi-view?${new URLSearchParams({ udids: selected.join(',') }).toString()}`)}
            title={
              selected.length < MULTI_VIEW_MIN ? `Pick at least ${MULTI_VIEW_MIN} devices to compare` : undefined
            }
          >
            View {selected.length} device{selected.length === 1 ? '' : 's'}
          </Button>
        </div>
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
              <DeviceCard
                key={device._id}
                device={device}
                selected={selected.includes(deviceKey(device))}
                {...cardProps}
              />
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
                <DeviceCard
                  key={device._id}
                  device={device}
                  selected={selected.includes(deviceKey(device))}
                  {...cardProps}
                />
              ))}
            </Grid>
          </details>
        ) : null}
      </QueryBoundary>
    </Page>
  );
}
