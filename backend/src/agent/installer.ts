import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HubClient, PendingInstall } from './hub-client';

const run = promisify(execFile);
const ADB_INSTALL_TIMEOUT_MS = 120_000;
/** Matches the ~1s cadence docs/modules/builds.md specifies for download progress. */
const PROGRESS_REPORT_INTERVAL_MS = 1000;

/**
 * Downloads one build artifact and installs it onto the device that
 * requested it, reporting status back to the hub at each step. Android goes
 * through `adb install -r` (same execFile/promisify shape as
 * sources/adb-discovery.ts). iOS has no real path on this codebase yet — no
 * Mac, no `ios-deploy` — so it reports a clear error instead of silently
 * no-opping, matching wdio-mobile-appium-automation's own honest
 * built-not-verified labeling for anything that can't actually be run here.
 */
export async function runInstall(
  hub: HubClient,
  pending: PendingInstall,
  adbPath = process.env.ADB_PATH ?? 'adb',
): Promise<void> {
  const { installRunId, deviceUdid, buildId, platform } = pending;

  if (platform === 'ios') {
    await hub.reportInstallProgress(installRunId, deviceUdid, {
      status: 'error',
      error: 'iOS install is not implemented on this agent (no ios-deploy / no macOS host available).',
    });
    return;
  }

  const destPath = path.join(os.tmpdir(), 'mobile-hub-installs', `${installRunId}-${deviceUdid}.apk`);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });

  try {
    await hub.reportInstallProgress(installRunId, deviceUdid, { status: 'downloading', progress: 0 });

    // Throttled: a large artifact produces thousands of chunk callbacks, and
    // one hub round-trip each would swamp the API and the WS fan-out for no
    // extra information at human timescales.
    let lastReportAt = 0;
    let lastReportedPct = 0;
    await hub.downloadArtifact(buildId, destPath, (downloadedBytes, totalBytes) => {
      // No Content-Length means no honest percentage — leave progress alone
      // and let the UI keep showing the indeterminate downloading phase
      // rather than inventing a number.
      if (!totalBytes) return;
      const pct = Math.min(99, Math.floor((downloadedBytes / totalBytes) * 100));
      const now = Date.now();
      if (now - lastReportAt < PROGRESS_REPORT_INTERVAL_MS || pct <= lastReportedPct) return;
      lastReportAt = now;
      lastReportedPct = pct;
      // Fire-and-forget: a dropped progress update must never fail an install
      // that is otherwise succeeding.
      void hub
        .reportInstallProgress(installRunId, deviceUdid, { status: 'downloading', progress: pct })
        .catch(() => {});
    });

    // `adb install` exposes no byte ratio, so progress deliberately stops
    // moving here and the phase carries the meaning instead. Fabricating a
    // rising number through this phase would be the same class of lie the
    // byte counting above exists to remove.
    await hub.reportInstallProgress(installRunId, deviceUdid, { status: 'installing', progress: 100 });
    await run(adbPath, ['-s', deviceUdid, 'install', '-r', destPath], { timeout: ADB_INSTALL_TIMEOUT_MS });

    await hub.reportInstallProgress(installRunId, deviceUdid, { status: 'done', progress: 100 });
  } catch (err) {
    await hub.reportInstallProgress(installRunId, deviceUdid, {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    fs.rm(destPath, { force: true }, () => {
      // Best-effort cleanup — a leftover temp APK is a disk-space nuisance,
      // not a correctness problem, so a failure here is not worth surfacing.
    });
  }
}
