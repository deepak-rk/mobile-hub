import { getBuild } from '../builds/builds.service';
import {
  deviceKey,
  getActiveInstallDeviceKeys,
  getInstallRun,
  getInstalledDevicesForBuild,
  triggerInstallRun,
} from '../device-installs/install-runs.service';

/**
 * App preflight: before a run's suite starts, make sure the build it names is
 * the app on its device.
 *
 * Without this a run trusted the test runner to install the app itself (via
 * the `app` capability), so a failed install surfaced as a failed *test*
 * and an install already in flight on the device raced the run. Here the
 * install goes through the hub's own install flow (the device's host agent
 * does the work), so it is tracked, attributable, and serialized with
 * installs someone else started.
 *
 * "On the device" is read from install history (`getInstalledDevicesForBuild`):
 * the hub has no adb to the device, only its host agent does. A device whose
 * app was removed by hand still reads as installed; the runner's own `app`
 * capability remains the backstop for that case.
 */

export type PreflightResult =
  | { ok: true; action: 'already_installed' | 'installed' }
  | { ok: false; errorClass: 'build_missing' | 'install_failed' | 'cancelled'; message: string };

export interface PreflightTarget {
  status: string;
  error: string | null;
}

export interface PreflightDeps {
  buildStatus(buildId: string): Promise<string | null>;
  isInstalled(buildId: string, machineId: string, udid: string): Promise<boolean>;
  installInFlight(machineId: string, udid: string): Promise<boolean>;
  startInstall(buildId: string, machineId: string, udid: string, triggeredBy: string): Promise<string>;
  installTarget(installRunId: string, machineId: string, udid: string): Promise<PreflightTarget | null>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export const defaultPreflightDeps: PreflightDeps = {
  async buildStatus(buildId) {
    return (await getBuild(buildId))?.status ?? null;
  },
  async isInstalled(buildId, machineId, udid) {
    const devices = await getInstalledDevicesForBuild(buildId);
    return devices.some((d) => d.machineId === machineId && d.deviceUdid === udid);
  },
  async installInFlight(machineId, udid) {
    return (await getActiveInstallDeviceKeys()).has(deviceKey(machineId, udid));
  },
  async startInstall(buildId, machineId, udid, triggeredBy) {
    const run = await triggerInstallRun({ buildId, devices: [{ udid, machineId }], triggeredBy });
    return String(run._id);
  },
  async installTarget(installRunId, machineId, udid) {
    const run = await getInstallRun(installRunId);
    const target = run?.targets.find((t) => t.machineId === machineId && t.deviceUdid === udid);
    return target ? { status: target.status, error: target.error } : null;
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

export interface PreflightInput {
  buildId: string;
  machineId: string;
  udid: string;
  triggeredBy: string;
  log(line: string): void;
  isCancelled(): boolean;
  /** Covers the wait for someone else's install and our own; default 10 minutes. */
  timeoutMs?: number;
  pollMs?: number;
}

export async function ensureAppOnDevice(
  input: PreflightInput,
  deps: PreflightDeps = defaultPreflightDeps,
): Promise<PreflightResult> {
  const { buildId, machineId, udid } = input;
  const deadline = deps.now() + (input.timeoutMs ?? 10 * 60_000);
  const pollMs = input.pollMs ?? 2_000;
  const cancelled = { ok: false, errorClass: 'cancelled', message: 'cancelled' } as const;

  const status = await deps.buildStatus(buildId);
  if (status !== 'ready') {
    return {
      ok: false,
      errorClass: 'build_missing',
      message: status ? `Build ${buildId} is ${status}, not ready to install` : `Build ${buildId} not found`,
    };
  }

  // An install already running on this device (any build) finishes first:
  // starting a second one would race it, and it may be installing this build.
  if (await deps.installInFlight(machineId, udid)) {
    input.log(`Waiting for an install already in progress on ${udid}\n`);
    while (await deps.installInFlight(machineId, udid)) {
      if (input.isCancelled()) return cancelled;
      if (deps.now() > deadline) {
        return { ok: false, errorClass: 'install_failed', message: `An install on ${udid} did not finish in time` };
      }
      await deps.sleep(pollMs);
    }
  }

  if (await deps.isInstalled(buildId, machineId, udid)) {
    input.log(`Build ${buildId} is already installed on ${udid}\n`);
    return { ok: true, action: 'already_installed' };
  }

  input.log(`Installing build ${buildId} on ${udid}\n`);
  const installRunId = await deps.startInstall(buildId, machineId, udid, input.triggeredBy);
  for (;;) {
    if (input.isCancelled()) return cancelled;
    const target = await deps.installTarget(installRunId, machineId, udid);
    if (target?.status === 'done') break;
    if (!target || target.status === 'error') {
      return {
        ok: false,
        errorClass: 'install_failed',
        message: `Install ${installRunId} failed: ${target?.error ?? 'install run disappeared'}`,
      };
    }
    if (deps.now() > deadline) {
      // Still queued at the deadline usually means no agent serves this host.
      return {
        ok: false,
        errorClass: 'install_failed',
        message: `Install ${installRunId} still ${target.status} after the preflight timeout`,
      };
    }
    await deps.sleep(pollMs);
  }

  // Re-verify against the same record a later run will read.
  if (!(await deps.isInstalled(buildId, machineId, udid))) {
    return {
      ok: false,
      errorClass: 'install_failed',
      message: `Install ${installRunId} finished but ${udid} does not show build ${buildId} as installed`,
    };
  }
  return { ok: true, action: 'installed' };
}
