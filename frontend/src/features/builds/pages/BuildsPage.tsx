import {
  Card,
  CardBody,
  EmptyState,
  List,
  Meta,
  MetaSep,
  Mono,
  Page,
  PageHeader,
  ProgressBar,
  QueryBoundary,
} from 'react-design-kit';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { icons } from '@/lib/icons';
import { formatBytes, formatRelative, shortId } from 'ts-format-utils';
import { useBuilds } from '../api/builds.api';
import type { Build } from '../types';
import styles from './BuildsPage.module.css';

/**
 * Builds move downloading → validating → ready|corrupt. The backend fetches
 * synchronously today (no per-byte progress events yet), so the bar shows
 * indeterminate-ish stage progress rather than inventing a byte count.
 */
function buildProgress(status: Build['status']): { value: number; complete: boolean } | null {
  if (status === 'downloading') return { value: 45, complete: false };
  if (status === 'validating') return { value: 100, complete: false };
  return null;
}

export function BuildsPage() {
  const { data: builds, isPending, error, refetch } = useBuilds();

  return (
    <Page>
      <PageHeader
        title="Builds"
        subtitle="Artifacts fetched by the platform. Every build is checksummed before it is marked ready."
      />

      <QueryBoundary
        isPending={isPending}
        error={error}
        isEmpty={builds?.length === 0}
        onRetry={() => void refetch()}
        empty={
          <EmptyState
            icon={icons.build}
            title="No builds yet"
            body="Trigger a fetch against a configured build provider and the artifact will be downloaded, checksummed, and listed here."
          />
        }
      >
        <List>
          {builds?.map((build) => {
            const progress = buildProgress(build.status);
            return (
              <Card key={build._id}>
                <CardBody>
                  <div className={styles.row}>
                    <div className={styles.main}>
                      <div className={styles.head}>
                        <span className={styles.project}>{build.project}</span>
                        <span className={styles.version}>{build.version}</span>
                        <StatusBadge status={build.status} />
                      </div>
                      <Meta>
                        <span>{build.platform === 'ios' ? 'iOS' : 'Android'}</span>
                        <MetaSep />
                        <span>{formatBytes(build.sizeBytes)}</span>
                        <MetaSep />
                        <span>{formatRelative(build.createdAt)}</span>
                      </Meta>
                    </div>

                    {build.checksum ? (
                      <div className={styles.checksum}>
                        <span className={styles.checksumLabel}>sha256</span>
                        <Mono>{shortId(build.checksum)}</Mono>
                      </div>
                    ) : null}
                  </div>

                  {progress ? (
                    <div className={styles.progress}>
                      <ProgressBar
                        value={progress.value}
                        complete={progress.complete}
                        label={build.status === 'validating' ? 'Verifying checksum…' : 'Downloading artifact…'}
                      />
                    </div>
                  ) : null}

                  {build.status === 'corrupt' ? (
                    <p className={styles.error}>
                      Integrity check failed — the artifact was discarded. Re-trigger the fetch to try again.
                    </p>
                  ) : null}
                </CardBody>
              </Card>
            );
          })}
        </List>
      </QueryBoundary>
    </Page>
  );
}
