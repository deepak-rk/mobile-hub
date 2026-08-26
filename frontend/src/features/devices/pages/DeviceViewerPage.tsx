import { Link, useParams } from 'react-router-dom';
import { Card, CardBody, DescriptionList, Mono, Page, PageHeader } from '@/components/ui/layout';
import { Button } from '@/components/ui/Button';
import { QueryBoundary } from '@/components/ui/states';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { icons, iconSize } from '@/lib/icons';
import { formatRelative, shortId } from 'ts-format-utils';
import { useDevice } from '../api/devices.api';
import { LockControls } from '../components/LockControls';
import { DeviceStream, StreamStopButton } from '../components/DeviceStream';
import { useAuth } from '@/features/auth/useAuth';
import styles from './DeviceViewerPage.module.css';

export function DeviceViewerPage() {
  const { udid } = useParams<{ udid: string }>();
  const { data: device, isPending, error, refetch } = useDevice(udid);
  const { user } = useAuth();

  return (
    <Page>
      <PageHeader
        title={device?.name ?? 'Device'}
        subtitle={udid}
        actions={
          <>
            {device ? <StreamStopButton device={device} /> : null}
            <Link to="/devices">
              <Button size="sm" variant="ghost">
                Back to devices
              </Button>
            </Link>
          </>
        }
      />

      <QueryBoundary isPending={isPending} error={error} onRetry={() => void refetch()} skeletonCount={2}>
        {device ? (
          <div className={styles.split}>
            <Card>
              <CardBody>
                <DeviceStream device={device} />
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
                        {
                          term: 'Held by',
                          // A raw user id tells the reader nothing; naming the
                          // caller's own lock is the one case we can resolve
                          // without a user-lookup endpoint.
                          value:
                            user && device.lock.heldBy === user.id ? (
                              <span>You</span>
                            ) : (
                              <Mono>{shortId(device.lock.heldBy)}</Mono>
                            ),
                        },
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
                  <div className={styles.lockActions}>
                    <LockControls device={device} />
                  </div>
                </div>
              </CardBody>
            </Card>
          </div>
        ) : null}
      </QueryBoundary>
    </Page>
  );
}
