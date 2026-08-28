import { useState } from 'react';
import { Button, DescriptionList, Dialog, Mono } from 'react-design-kit';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { icons, iconSize } from '@/lib/icons';
import { formatBytes, formatRelative } from 'ts-format-utils';
import type { Build } from '../types';
import styles from './BuildDetailDialog.module.css';

/**
 * Build detail (drill-down level 3) — the real `Build` metadata a table row
 * abbreviates: the full sha256 (the row only shows a shortened one), the
 * on-disk path, and the source URL. Deliberately "View" only — mobile-hub has
 * no install pipeline (docs/TODO.md "Stubs & placeholders"), so there is no
 * Install action here, not even a disabled one.
 */
export function BuildDetailDialog({ build, onClose }: { build: Build | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false);

  function copyChecksum() {
    if (!build?.checksum) return;
    void navigator.clipboard.writeText(build.checksum).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <Dialog
      open={build !== null}
      onClose={onClose}
      title={build ? `${build.project} · ${build.version}` : 'Build'}
      actions={
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    >
      {build ? (
        <>
          <div className={styles.head}>
            <StatusBadge status={build.status} />
            <span className={styles.platform}>{build.platform === 'ios' ? 'iOS' : 'Android'}</span>
          </div>

          {build.status === 'corrupt' ? (
            <p className={styles.error}>Integrity check failed — re-trigger the fetch to try again.</p>
          ) : null}

          <DescriptionList
            items={[
              { term: 'Project', value: build.project },
              { term: 'Version', value: <Mono>{build.version}</Mono> },
              { term: 'Size', value: formatBytes(build.sizeBytes) },
              {
                term: 'sha256',
                value: build.checksum ? (
                  <span className={styles.checksumRow}>
                    <Mono>{build.checksum}</Mono>
                    <Button size="sm" variant="ghost" onClick={copyChecksum}>
                      <icons.copy size={iconSize.dense} aria-hidden="true" />
                      {copied ? 'Copied' : 'Copy'}
                    </Button>
                  </span>
                ) : (
                  '—'
                ),
              },
              { term: 'On disk at', value: build.artifactPath ? <Mono>{build.artifactPath}</Mono> : '—' },
              { term: 'Source URL', value: build.artifactUrl ? <Mono>{build.artifactUrl}</Mono> : '—' },
              { term: 'Fetched', value: formatRelative(build.fetchedAt) },
              { term: 'Integrity validated', value: formatRelative(build.integrityValidatedAt) },
              ...(build.status === 'purged'
                ? [{ term: 'Purged', value: formatRelative(build.purgedAt) }]
                : []),
              { term: 'Triggered', value: formatRelative(build.createdAt) },
            ]}
          />
        </>
      ) : null}
    </Dialog>
  );
}
