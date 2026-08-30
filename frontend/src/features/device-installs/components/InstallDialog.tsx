import { useState } from 'react';
import { Button, Dialog, ProgressBar } from 'react-design-kit';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { useDevices } from '@/features/devices/api/devices.api';
import type { Build } from '../../builds/types';
import { useInstallRun, useTriggerInstallRun } from '../api/device-installs.api';
import { useInstallRunStream } from '../api/useInstallRunStream';
import styles from './InstallDialog.module.css';

/**
 * Two phases in one dialog rather than a separate progress page: pick
 * devices, trigger, then watch the same InstallRun's targets resolve over
 * its WS stream — mirrors execution's queued->preparing->running pattern in
 * shape, but per-device rather than per-run since a single InstallRun can
 * target many devices at once (see install-run.model.ts).
 */
export function InstallDialog({ build, onClose }: { build: Build | null; onClose: () => void }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [installRunId, setInstallRunId] = useState<string | null>(null);

  const { data: devices } = useDevices({ platform: build?.platform });
  const trigger = useTriggerInstallRun();

  const { state: streamState } = useInstallRunStream(installRunId ?? undefined);
  const { data: run } = useInstallRun(installRunId ?? undefined, streamState === 'live');

  function toggle(udid: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(udid)) next.delete(udid);
      else next.add(udid);
      return next;
    });
  }

  function handleClose() {
    setSelected(new Set());
    setInstallRunId(null);
    trigger.reset();
    onClose();
  }

  function handleInstall() {
    if (!build) return;
    trigger.mutate(
      { buildId: build._id, deviceUdids: [...selected] },
      { onSuccess: (created) => setInstallRunId(created._id) },
    );
  }

  const targets = run?.targets ?? [];

  return (
    <Dialog
      open={build !== null}
      onClose={handleClose}
      title={build ? `Install ${build.project} ${build.version}` : 'Install'}
      actions={
        installRunId ? (
          <Button size="sm" variant="ghost" onClick={handleClose}>
            Close
          </Button>
        ) : (
          <>
            <Button size="sm" variant="ghost" onClick={handleClose}>
              Cancel
            </Button>
            <Button size="sm" disabled={selected.size === 0 || trigger.isPending} onClick={handleInstall}>
              {trigger.isPending ? 'Starting…' : `Install to ${selected.size || ''} device${selected.size === 1 ? '' : 's'}`}
            </Button>
          </>
        )
      }
    >
      {!build ? null : installRunId ? (
        <ul className={styles.targetList}>
          {targets.map((t) => (
            <li key={t.deviceUdid} className={styles.targetRow}>
              <div className={styles.targetHead}>
                <span className={styles.targetName}>{devices?.find((d) => d.udid === t.deviceUdid)?.name ?? t.deviceUdid}</span>
                <StatusBadge status={t.status} />
              </div>
              {/* A determinate bar only while real byte progress is moving.
                  `adb install` exposes no byte ratio, so the installing phase
                  shows a label instead of a bar frozen at 100% pretending to
                  still be working. */}
              {t.status === 'downloading' && t.progress > 0 ? (
                <ProgressBar value={t.progress} label={`${t.progress}%`} />
              ) : null}
              {t.status === 'downloading' && t.progress === 0 ? (
                <p className={styles.phase}>Starting download…</p>
              ) : null}
              {t.status === 'installing' ? <p className={styles.phase}>Installing on device…</p> : null}
              {t.status === 'error' && t.error ? <p className={styles.error}>{t.error}</p> : null}
            </li>
          ))}
        </ul>
      ) : (
        <>
          <p className={styles.hint}>
            {devices?.length ? `${build.platform === 'ios' ? 'iOS' : 'Android'} devices` : 'No matching devices found.'}
          </p>
          <ul className={styles.deviceList}>
            {(devices ?? []).map((d) => (
              <li key={d.udid}>
                <label className={styles.deviceRow}>
                  <input
                    type="checkbox"
                    checked={selected.has(d.udid)}
                    disabled={d.status === 'offline'}
                    onChange={() => toggle(d.udid)}
                  />
                  <span className={styles.deviceName}>{d.name}</span>
                  <StatusBadge status={d.status} bare />
                </label>
              </li>
            ))}
          </ul>
        </>
      )}
    </Dialog>
  );
}
