import { useState } from 'react';
import { Button, Dialog, ProgressBar } from 'react-design-kit';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { installTargetBadgeStatus } from '@/lib/status';
import { icons, iconSize } from '@/lib/icons';
import { useDevices } from '@/features/devices/api/devices.api';
import { deviceKey } from '@/features/devices/lib/deviceKey';
import { isOfflineStatus } from '@/features/devices/lib/deviceCounts';
import type { Build } from '../../builds/types';
import type { InstallTarget } from '../types';
import { useInstallRun, useInstalledDevices, useTriggerInstallRun } from '../api/device-installs.api';
import { useInstallRunStream } from '../api/useInstallRunStream';
import styles from './InstallDialog.module.css';

/**
 * The phases whose progress is a real byte measurement, so a determinate bar
 * tells the truth. `installing` is deliberately absent: `pm install` exposes
 * no byte ratio.
 */
const MEASURED_PHASES: InstallTarget['status'][] = ['downloading', 'transferring'];

const PHASE_LABELS: Record<string, string> = {
  downloading: 'Downloading to host',
  transferring: 'Copying to device',
};

/**
 * Two phases in one dialog rather than a separate progress page: pick
 * devices, trigger, then watch the same InstallRun's targets resolve over
 * its WS stream — mirrors execution's queued->preparing->running pattern in
 * shape, but per-device rather than per-run since a single InstallRun can
 * target many devices at once (see install-run.model.ts).
 */
const key = (machineId: string, udid: string) => deviceKey({ machineId, udid });

export function InstallDialog({ build, onClose }: { build: Build | null; onClose: () => void }) {
  // Keyed by host + udid: emulator serials repeat on every host, so a bare
  // udid can't say which device was ticked (the backend now refuses it with
  // 409 when it is ambiguous).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [installRunId, setInstallRunId] = useState<string | null>(null);

  const { data: devices, isPending: devicesPending, isError: devicesError } = useDevices({ platform: build?.platform });
  const { data: installedDevices } = useInstalledDevices(build?._id);
  // Undefined while unknown, so the UI can distinguish "none" from "not
  // loaded yet" rather than rendering a confident zero.
  const installedUdids = installedDevices ? new Set(installedDevices.map((d) => key(d.machineId, d.deviceUdid))) : undefined;
  const trigger = useTriggerInstallRun();

  const { state: streamState } = useInstallRunStream(installRunId ?? undefined);
  const { data: run } = useInstallRun(installRunId ?? undefined, streamState === 'live');

  // Derived from the *current* device list, so a device ticked before it went
  // offline/unreachable drops out of both the count and the submitted set
  // instead of being sent to a device that can't receive it.
  const selectedDevices = (devices ?? []).filter(
    (d) => !isOfflineStatus(d.status) && selected.has(key(d.machineId, d.udid)),
  );

  function toggle(k: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
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
      {
        buildId: build._id,
        devices: selectedDevices.map((d) => ({ udid: d.udid, machineId: d.machineId })),
      },
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
            <Button size="sm" disabled={selectedDevices.length === 0 || trigger.isPending} onClick={handleInstall}>
              {trigger.isPending ? 'Starting…' : `Install to ${selectedDevices.length || ''} device${selectedDevices.length === 1 ? '' : 's'}`}
            </Button>
          </>
        )
      }
    >
      {!build ? null : installRunId ? (
        <ul className={styles.targetList}>
          {targets.map((t) => (
            <li key={key(t.machineId, t.deviceUdid)} className={styles.targetRow}>
              <div className={styles.targetHead}>
                <span className={styles.targetName}>{devices?.find((d) => d.udid === t.deviceUdid && d.machineId === t.machineId)?.name ?? t.deviceUdid}</span>
                <StatusBadge status={installTargetBadgeStatus(t)} />
              </div>
              {/* A determinate bar only where bytes are genuinely measured:
                  the HTTP download and the push to the device. `pm install`
                  does dexopt and exposes no byte ratio, so it shows a label
                  rather than a bar frozen at 100% pretending to still move. */}
              {MEASURED_PHASES.includes(t.status) && t.progress > 0 ? (
                <ProgressBar value={t.progress} label={`${PHASE_LABELS[t.status]} · ${t.progress}%`} />
              ) : null}
              {MEASURED_PHASES.includes(t.status) && t.progress === 0 ? (
                <p className={styles.phase}>{PHASE_LABELS[t.status]}…</p>
              ) : null}
              {t.status === 'installing' ? <p className={styles.phase}>Installing on device…</p> : null}
              {t.status === 'granting-permissions' ? <p className={styles.phase}>Granting permissions…</p> : null}
              {t.status === 'error' && t.error ? <p className={styles.error}>{t.error}</p> : null}
              {t.status === 'done' && t.error ? (
                <p className={styles.warning}>
                  <icons.warning size={iconSize.dense} aria-hidden="true" />
                  <span>
                    <strong>Warning:</strong> {t.error}
                  </span>
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <>
          <p className={styles.hint}>
            {/* "None found" only once the list has actually loaded — while
                pending or failed, saying so would be a confident lie. */}
            {devicesPending
              ? 'Loading devices…'
              : devicesError
                ? 'Could not load devices.'
                : devices?.length
                  ? `${build.platform === 'ios' ? 'iOS' : 'Android'} devices`
                  : 'No matching devices found.'}
            {/* Only stated once it is actually known — a bare "0 devices"
                while the query is still in flight would read as a fact. */}
            {installedUdids ? (
              <span className={styles.installedCount}>
                {' · '}
                {installedUdids.size === 0
                  ? 'not installed anywhere yet'
                  : `installed on ${installedUdids.size} device${installedUdids.size === 1 ? '' : 's'}`}
              </span>
            ) : null}
          </p>
          <ul className={styles.deviceList}>
            {(devices ?? []).map((d) => (
              <li key={key(d.machineId, d.udid)}>
                <label className={styles.deviceRow}>
                  <input
                    type="checkbox"
                    checked={!isOfflineStatus(d.status) && selected.has(key(d.machineId, d.udid))}
                    disabled={isOfflineStatus(d.status)}
                    onChange={() => toggle(key(d.machineId, d.udid))}
                  />
                  <span className={styles.deviceName}>{d.name}</span>
                  {/* Reinstalling is legitimate (a rebuild under the same
                      version), so this informs rather than disables. */}
                  {installedUdids?.has(key(d.machineId, d.udid)) ? <span className={styles.installedTag}>installed</span> : null}
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
