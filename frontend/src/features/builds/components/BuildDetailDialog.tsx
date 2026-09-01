import { useState } from 'react';
import { Button, DescriptionList, Dialog, Mono } from 'react-design-kit';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { icons, iconSize } from '@/lib/icons';
import { formatBytes, formatRelative } from 'ts-format-utils';
import { useAuth } from '@/features/auth/useAuth';
import { InstallDialog } from '@/features/device-installs/components/InstallDialog';
import type { ApiError } from '@/services/api';
import { usePurgeBuild, useRefetchBuild } from '../api/builds.api';
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
  const [confirmPurge, setConfirmPurge] = useState(false);
  const purge = usePurgeBuild();
  const refetch = useRefetchBuild();
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
        open={build !== null && !installOpen && !confirmPurge}
        onClose={onClose}
        title={build ? `${build.project} · ${build.version}` : 'Build'}
        actions={
          <>
            <Button size="sm" variant="ghost" onClick={onClose}>
              Close
            </Button>
            {/* Only a `ready` build has a local copy to reclaim. Destructive,
                so it confirms first — and it removes the artifact, not the
                record, which is why it says "Remove local copy". */}
            {build?.status === 'ready' && can('operator', 'admin') ? (
              <Button size="sm" variant="destructive" onClick={() => setConfirmPurge(true)}>
                <icons.remove size={iconSize.dense} aria-hidden="true" />
                Remove local copy
              </Button>
            ) : null}
            {/* The way back from a purge. Offered only when there is a source
                recorded to fetch from, so it can never be a button that fails. */}
            {build && build.status !== 'ready' && build.artifactUrl && can('operator', 'admin') ? (
              <Button size="sm" disabled={refetch.isPending} onClick={() => refetch.mutate(build._id)}>
                <icons.downloading size={iconSize.dense} aria-hidden="true" />
                {refetch.isPending ? 'Downloading…' : 'Download again'}
              </Button>
            ) : null}
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

      <Dialog
        open={confirmPurge}
        onClose={() => setConfirmPurge(false)}
        title="Remove local copy?"
        actions={
          <>
            <Button size="sm" variant="ghost" onClick={() => setConfirmPurge(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={purge.isPending}
              onClick={() =>
                build &&
                purge.mutate(build._id, {
                  onSuccess: () => {
                    setConfirmPurge(false);
                    onClose();
                  },
                })
              }
            >
              {purge.isPending ? 'Removing…' : 'Remove'}
            </Button>
          </>
        }
      >
        <p className={styles.error}>
          {(purge.error as ApiError | null)?.message ?? ''}
        </p>
        <p>
          Deletes this build&apos;s artifact from disk to reclaim space. The build stays in the catalog and can be
          fetched again. Refused while an install is still using it.
        </p>
      </Dialog>
    </>
  );
}
