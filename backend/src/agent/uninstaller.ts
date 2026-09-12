import { execFile } from 'child_process';
import { promisify } from 'util';
import { HubClient, PendingUninstall } from './hub-client';

const run = promisify(execFile);
const ADB_UNINSTALL_TIMEOUT_MS = 60_000;

/**
 * Removes one package from one device, reporting status back to the hub.
 *
 * Deliberately no download/transfer phases to sub-divide — `pm uninstall`
 * takes nothing but a package name already on the device, so there is
 * exactly one real step here, unlike install's three. `adb uninstall`
 * (rather than `pm uninstall` over `shell`) is used because it surfaces a
 * clean `Success`/`Failure [...]` on stdout the same way `pm install` does,
 * without needing a `shell` hop first.
 */
export async function runUninstall(
  hub: HubClient,
  pending: PendingUninstall,
  adbPath = process.env.ADB_PATH ?? 'adb',
): Promise<void> {
  const { uninstallRunId, deviceUdid, packageName } = pending;

  try {
    await hub.reportUninstallProgress(uninstallRunId, deviceUdid, { status: 'uninstalling' });

    const { stdout } = await run(adbPath, ['-s', deviceUdid, 'uninstall', packageName], {
      timeout: ADB_UNINSTALL_TIMEOUT_MS,
    });
    // Mirrors installer.ts's own `pm install` check: `adb uninstall` can print
    // a failure reason on stdout with a zero exit code, so the exit code
    // alone would let a failed uninstall be recorded as done. A package that
    // was never there (already removed by hand, or a stale record) also
    // reports failure here — a real, reportable outcome, not swallowed.
    if (!/^Success/m.test(stdout)) {
      throw new Error(`adb uninstall did not report success: ${stdout.trim() || '(no output)'}`);
    }

    await hub.reportUninstallProgress(uninstallRunId, deviceUdid, { status: 'done' });
  } catch (err) {
    await hub.reportUninstallProgress(uninstallRunId, deviceUdid, {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
