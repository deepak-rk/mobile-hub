import { Link, useParams } from 'react-router-dom';
import { Card, CardBody, DescriptionList, Mono, Page, PageHeader } from '@/components/ui/layout';
import { Button } from '@/components/ui/Button';
import { QueryBoundary } from '@/components/ui/states';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { icons, iconSize } from '@/lib/icons';
import { formatRelative } from '@/lib/format';
import { useDevice } from '../api/devices.api';
import styles from './DeviceViewerPage.module.css';

export function DeviceViewerPage() {
  const { udid } = useParams<{ udid: string }>();
  const { data: device, isPending, error, refetch } = useDevice(udid);

  return (
    <Page>
      <PageHeader
        title={device?.name ?? 'Device'}
        subtitle={udid}
        actions={
          <Link to="/devices">
            <Button size="sm" variant="ghost">
              Back to devices
            </Button>
          </Link>
        }
      />

      <QueryBoundary isPending={isPending} error={error} onRetry={() => void refetch()} skeletonCount={2}>
        {device ? (
          <div className={styles.split}>
            <Card>
              <CardBody>
                {/* The live stream surface. The backend streaming module isn't
                    built yet, so this states that plainly rather than showing a
                    fake player — guidelines §1: never hide real-time state. */}
                <div className={styles.stage}>
                  <icons.stream size={32} aria-hidden="true" />
                  <div className={styles.stageTitle}>Live view unavailable</div>
                  <p className={styles.stageBody}>
                    Device streaming is not implemented in the backend yet. When it lands, the MJPEG/H.264
                    feed and its connection banner appear here.
                  </p>
                </div>
              </CardBody>
            </Card>

            <Card>
              <CardBody>
                <div className={styles.panelHead}>
                  <span className={styles.panelTitle}>Details</span>
                  <StatusBadge status={device.status} />
                </div>

                <DescriptionList
                  items={[
                    { term: 'UDID', value: <Mono>{device.udid}</Mono> },
                    { term: 'Host', value: <Mono>{device.machineId}</Mono> },
                    {
                      term: 'Platform',
                      value: `${device.platform === 'ios' ? 'iOS' : 'Android'} ${device.osVersion}`,
                    },
                    { term: 'Model', value: device.model },
                    { term: 'Connection', value: device.connectionType },
                    { term: 'Reachable', value: device.isLocallyReachable ? 'Yes' : 'No' },
                    { term: 'Last seen', value: formatRelative(device.lastSeenAt) },
                  ]}
                />

                <div className={styles.lockSection}>
                  <div className={styles.lockHead}>
                    <span className={styles.panelTitle}>Lock</span>
                  </div>
                  {device.lock ? (
                    <DescriptionList
                      items={[
                        { term: 'Held by', value: <Mono>{device.lock.heldBy}</Mono> },
                        { term: 'Since', value: formatRelative(device.lock.acquiredAt) },
                        { term: 'Reason', value: device.lock.reason ?? '—' },
                      ]}
                    />
                  ) : (
                    <p className={styles.free}>
                      <icons.unlocked size={iconSize.dense} aria-hidden="true" />
                      Available — no one is holding this device.
                    </p>
                  )}
                  {/* Lock/unlock needs an authenticated session; there's no
                      login screen yet, so the action is deliberately absent
                      rather than present-and-broken. */}
                  <p className={styles.note}>Sign-in is required to acquire or release a lock.</p>
                </div>
              </CardBody>
            </Card>
          </div>
        ) : null}
      </QueryBoundary>
    </Page>
  );
}
