import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, DescriptionList, Dialog, Mono } from 'react-design-kit';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { icons, iconSize } from '@/lib/icons';
import { formatBytes, formatRelative } from 'ts-format-utils';
import { useAuth } from '@/features/auth/useAuth';
import { InstallDialog } from '@/features/device-installs/components/InstallDialog';
import {
  useInstalledDevices,
  useTriggerUninstallRun,
  type InstalledDevice,
} from '@/features/device-installs/api/device-installs.api';
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
  const [confirmUninstall, setConfirmUninstall] = useState<InstalledDevice | null>(null);
  const purge = usePurgeBuild();
  const refetch = useRefetchBuild();
  const uninstall = useTriggerUninstallRun();
  const { can } = useAuth();
  const { data: installedDevices } = useInstalledDevices(build?._id);

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
        open={build !== null && !installOpen && !confirmPurge && !confirmUninstall}
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
              // No current build provider reports these — conditional on the
              // whole object, and each field within it, so a build with no
              // compatibility info looks exactly like it did before this
              // existed, not like an empty "N/A" row.
              ...(build.constraints?.minOsVersion
                ? [{ term: 'Min OS version', value: build.constraints.minOsVersion }]
                : []),
              ...(build.constraints?.architecture
                ? [{ term: 'Architecture', value: build.constraints.architecture }]
                : []),
              ...(build.constraints?.features && build.constraints.features.length > 0
                ? [{ term: 'Requires', value: build.constraints.features.join(', ') }]
                : []),
              // Same conditional-per-field pattern as constraints above: no
              // current provider populates the CI-metadata fields, so they
              // stay absent from the list entirely rather than showing "—".
              ...(build.provenance?.branch ? [{ term: 'Branch', value: build.provenance.branch }] : []),
              ...(build.provenance?.commitSha
                ? [{ term: 'Commit', value: <Mono>{build.provenance.commitSha}</Mono> }]
                : []),
              ...(build.provenance?.commitTitle
                ? [{ term: 'Commit title', value: build.provenance.commitTitle }]
                : []),
              ...(build.provenance?.buildNumber
                ? [{ term: 'Build number', value: build.provenance.buildNumber }]
                : []),
              ...(build.provenance?.sourceTimestamp
                ? [{ term: 'Source timestamp', value: formatRelative(build.provenance.sourceTimestamp) }]
                : []),
              { term: 'Fetched', value: formatRelative(build.fetchedAt) },
              { term: 'Integrity validated', value: formatRelative(build.integrityValidatedAt) },
              ...(build.status === 'purged'
                ? [{ term: 'Purged', value: formatRelative(build.purgedAt) }]
                : []),
              { term: 'Triggered', value: formatRelative(build.createdAt) },
            ]}
          />

          {/* Undefined while loading, so this never flashes "not installed
              anywhere" before the real answer arrives. Derived from install
              history — a device that later received a *different* build of
              the same app no longer counts here, since it's not carrying
              this one any more. */}
          {installedDevices ? (
            <div className={styles.installed}>
              <h3 className={styles.installedHeading}>
                <icons.device size={iconSize.dense} aria-hidden="true" />
                {installedDevices.length === 0
                  ? 'Not installed on any device'
                  : `Installed on ${installedDevices.length} device${installedDevices.length === 1 ? '' : 's'}`}
              </h3>
              {installedDevices.length > 0 ? (
                <ul className={styles.installedList}>
                  {installedDevices.map((d) => (
                    <li key={d.deviceUdid}>
                      <Link to={`/devices/${d.deviceUdid}`}>{d.deviceName ?? d.deviceUdid}</Link>
                      <span className={styles.installedMeta}>
                        <span className={styles.installedWhen}>installed {formatRelative(d.installedAt)}</span>
                        {/* Only offered when the agent positively identified
                            the package at install time — nothing to
                            uninstall without knowing what it's called. */}
                        {d.packageName && can('operator', 'admin') ? (
                          <Button size="sm" variant="ghost" onClick={() => setConfirmUninstall(d)}>
                            <icons.remove size={iconSize.dense} aria-hidden="true" />
                            Uninstall
                          </Button>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
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

      <Dialog
        open={confirmUninstall !== null}
        onClose={() => setConfirmUninstall(null)}
        title="Uninstall from this device?"
        actions={
          <>
            <Button size="sm" variant="ghost" onClick={() => setConfirmUninstall(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={uninstall.isPending}
              onClick={() =>
                build &&
                confirmUninstall &&
                uninstall.mutate(
                  {
                    packageName: confirmUninstall.packageName as string,
                    project: build.project,
                    devices: [{ udid: confirmUninstall.deviceUdid, machineId: confirmUninstall.machineId }],
                  },
                  { onSuccess: () => setConfirmUninstall(null) },
                )
              }
            >
              {uninstall.isPending ? 'Uninstalling…' : 'Uninstall'}
            </Button>
          </>
        }
      >
        <p className={styles.error}>{(uninstall.error as ApiError | null)?.message ?? ''}</p>
        <p>
          Removes <Mono>{confirmUninstall?.packageName}</Mono> from{' '}
          {confirmUninstall?.deviceName ?? confirmUninstall?.deviceUdid}, including its data on that device. The
          agent picks this up on its next poll — this dialog closes once the request is accepted, not once the
          device confirms it.
        </p>
      </Dialog>
    </>
  );
}
