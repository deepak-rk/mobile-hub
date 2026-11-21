import { Link } from 'react-router-dom';
import { Button, EmptyState, Page, PageHeader, QueryBoundary } from 'react-design-kit';
import { icons } from '@/lib/icons';
import { useDevices } from '../api/devices.api';
import { useMultiViewSelection, MULTI_VIEW_MAX } from '../hooks/useMultiViewSelection';
import { MultiViewTile } from '../components/MultiViewTile';
import { deviceKey } from '../lib/deviceKey';
import styles from './MultiDeviceViewPage.module.css';

/**
 * Watch several devices' live views at once. Each tile is a real, separate
 * capture-service viewer (streaming.service.ts's fan-out is per-*device*,
 * not global), so this is additive on top of the single-device page, not a
 * different code path — picking a device here and opening its own detail
 * page both just attach another viewer to the same host-side capture.
 */
function isOnline(device: { status: string }): boolean {
  return device.status !== 'offline' && device.status !== 'unreachable';
}

export function MultiDeviceViewPage() {
  const { data: devices, isPending, error, refetch } = useDevices();
  const { selected, toggle, remove, clear, selectMany, atMax } = useMultiViewSelection();
  const selectedDevices = devices?.filter((d) => selected.includes(deviceKey(d))) ?? [];
  // Selection entries are deviceKey()s (host + udid), not bare udids — see lib/deviceKey.ts.
  const onlineUdids = devices?.filter(isOnline).map(deviceKey) ?? [];

  return (
    <Page>
      <PageHeader
        title="Multi-view"
        subtitle={`Watch up to ${MULTI_VIEW_MAX} devices at once.`}
        actions={
          <>
            {selected.length > 0 ? (
              <Button size="sm" variant="ghost" onClick={clear}>
                Clear all
              </Button>
            ) : null}
            {/* Every other detail/sub-page in this app has a plain way back to
                its parent list (see DeviceViewerPage/RunDetailPage) — this
                page was missing the equivalent. */}
            <Link to="/devices">
              <Button size="sm" variant="ghost">
                Back to devices
              </Button>
            </Link>
          </>
        }
      />

      <QueryBoundary isPending={isPending} error={error} onRetry={() => void refetch()}>
        <div className={styles.pickerToolbar}>
          <span className={styles.pickerLabel}>Pick devices</span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => selectMany(onlineUdids)}
            disabled={onlineUdids.length === 0}
            title={
              onlineUdids.length === 0
                ? 'No online devices to select'
                : `Watch the first ${Math.min(MULTI_VIEW_MAX, onlineUdids.length)} online device(s)`
            }
          >
            Select all online
          </Button>
        </div>
        <div className={styles.picker}>
          {devices?.map((device) => {
            const isSelected = selected.includes(deviceKey(device));
            const disabled = !isSelected && atMax;
            return (
              <button
                key={deviceKey(device)}
                type="button"
                className={`${styles.chip} ${isSelected ? styles.chipActive : ''}`}
                onClick={() => toggle(deviceKey(device))}
                disabled={disabled}
                aria-pressed={isSelected}
                title={disabled ? `Watching ${MULTI_VIEW_MAX} already — remove one first` : undefined}
              >
                {device.name}
              </button>
            );
          })}
        </div>

        {selectedDevices.length === 0 ? (
          <EmptyState
            icon={icons.stream}
            title="Nothing selected"
            body="Pick devices above to watch them together in a grid."
          />
        ) : (
          <div className={styles.grid}>
            {selectedDevices.map((device) => (
              <MultiViewTile key={deviceKey(device)} device={device} onRemove={() => remove(deviceKey(device))} />
            ))}
          </div>
        )}
      </QueryBoundary>
    </Page>
  );
}
