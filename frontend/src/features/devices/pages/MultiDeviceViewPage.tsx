import { Button, EmptyState, Page, PageHeader, QueryBoundary } from 'react-design-kit';
import { icons } from '@/lib/icons';
import { useDevices } from '../api/devices.api';
import { useMultiViewSelection, MULTI_VIEW_MAX } from '../hooks/useMultiViewSelection';
import { MultiViewTile } from '../components/MultiViewTile';
import styles from './MultiDeviceViewPage.module.css';

/**
 * Watch several devices' live views at once. Each tile is a real, separate
 * capture-service viewer (streaming.service.ts's fan-out is per-*device*,
 * not global), so this is additive on top of the single-device page, not a
 * different code path — picking a device here and opening its own detail
 * page both just attach another viewer to the same host-side capture.
 */
export function MultiDeviceViewPage() {
  const { data: devices, isPending, error, refetch } = useDevices();
  const { selected, toggle, remove, clear, atMax } = useMultiViewSelection();
  const selectedDevices = devices?.filter((d) => selected.includes(d.udid)) ?? [];

  return (
    <Page>
      <PageHeader
        title="Multi-view"
        subtitle={`Watch up to ${MULTI_VIEW_MAX} devices at once.`}
        actions={
          selected.length > 0 ? (
            <Button size="sm" variant="ghost" onClick={clear}>
              Clear all
            </Button>
          ) : undefined
        }
      />

      <QueryBoundary isPending={isPending} error={error} onRetry={() => void refetch()}>
        <div className={styles.picker}>
          {devices?.map((device) => {
            const isSelected = selected.includes(device.udid);
            const disabled = !isSelected && atMax;
            return (
              <button
                key={device.udid}
                type="button"
                className={`${styles.chip} ${isSelected ? styles.chipActive : ''}`}
                onClick={() => toggle(device.udid)}
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
              <MultiViewTile key={device.udid} device={device} onRemove={() => remove(device.udid)} />
            ))}
          </div>
        )}
      </QueryBoundary>
    </Page>
  );
}
