import { useState } from 'react';
import { Button, DescriptionList, Dialog, Mono } from 'react-design-kit';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { icons, iconSize } from '@/lib/icons';
import { formatBytes, formatRelative } from 'ts-format-utils';
import { useAuth } from '@/features/auth/useAuth';
import { InstallDialog } from '@/features/device-installs/components/InstallDialog';
import type { Build } from '../types';
import styles from './BuildDetailDialog.module.css';

/**
 * Build detail (drill-down level 3) — the real `Build` metadata a table row
 * abbreviates: the full sha256 (the row only shows a shortened one), the
 * on-disk path, and the source URL. Install is only offered once the build
 * is `ready` and only to callers who can trigger one (frontend/CLAUDE.md:
 * hide the action rather than render a disabled control that 403s).
 */
export function BuildDetailDialog({ build, onClose }: { build: Build | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const [installOpen, setInstallOpen] = useState(false);
  const { can } = useAuth();

  function copyChecksum() {
    if (!build?.checksum) return;
    void navigator.clipboard.writeText(build.checksum).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <>
      <Dialog
        open={build !== null && !installOpen}
        onClose={onClose}
        title={build ? `${build.project} · ${build.version}` : 'Build'}
        actions={
          <>
            <Button size="sm" variant="ghost" onClick={onClose}>
              Close
            </Button>
            {build?.status === 'ready' && can('operator', 'admin') ? (
              <Button size="sm" onClick={() => setInstallOpen(true)}>
                Install
              </Button>
            ) : null}
          </>
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
      {installOpen ? <InstallDialog build={build} onClose={() => setInstallOpen(false)} /> : null}
    </>
  );
}
