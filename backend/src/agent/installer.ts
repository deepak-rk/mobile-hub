import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HubClient, PendingInstall } from './hub-client';

const run = promisify(execFile);
const ADB_INSTALL_TIMEOUT_MS = 120_000;
const ADB_PUSH_TIMEOUT_MS = 300_000;
const ADB_SHORT_TIMEOUT_MS = 10_000;
/** Matches the ~1s cadence docs/modules/builds.md specifies for download progress. */
const PROGRESS_REPORT_INTERVAL_MS = 1000;
/** Where the artifact is staged on the device before `pm install` reads it. */
const REMOTE_STAGING_DIR = '/data/local/tmp';

/**
 * Throttles progress reports to the hub.
 *
 * A multi-hundred-MB transfer produces thousands of samples; one hub round
 * trip each would swamp the API and the WS fan-out without telling a human
 * anything extra. Reports are fire-and-forget — a dropped progress update must
 * never fail an install that is otherwise succeeding.
 */
function throttledReporter(
  hub: HubClient,
  installRunId: string,
  deviceUdid: string,
  status: 'downloading' | 'transferring',
) {
  let lastAt = 0;
  let lastPct = 0;
  return (done: number, total: number | null): void => {
    if (!total) return; // no honest denominator — leave progress alone
    const pct = Math.min(99, Math.floor((done / total) * 100));
    const now = Date.now();
    if (now - lastAt < PROGRESS_REPORT_INTERVAL_MS || pct <= lastPct) return;
    lastAt = now;
    lastPct = pct;
    void hub.reportInstallProgress(installRunId, deviceUdid, { status, progress: pct }).catch(() => {});
  };
}

/**
 * Pushes the artifact to the device, reporting real transfer progress.
 *
 * Progress is measured by polling the file's size *on the device* rather than
 * by parsing `adb push` output: adb only prints its progress meter to a TTY,
 * so from a service its stdout carries nothing until the final summary line
 * (verified against a real emulator). Polling `stat` is a real measurement of
 * bytes that actually landed, not an estimate.
 *
 * `adb push` is used rather than `pm install-write` streaming over stdin —
 * that path was tried against a real device and fails on Windows, where
 * `adb shell` is not binary-safe (it truncated a 123 MB APK to 134 bytes).
 */
async function pushToDevice(
  adbPath: string,
  deviceUdid: string,
  localPath: string,
  remotePath: string,
  totalBytes: number,
  onProgress: (done: number, total: number) => void,
): Promise<void> {
  const push = run(adbPath, ['-s', deviceUdid, 'push', localPath, remotePath], { timeout: ADB_PUSH_TIMEOUT_MS });

  let polling = true;
  const poll = (async () => {
    while (polling) {
      await new Promise((r) => setTimeout(r, PROGRESS_REPORT_INTERVAL_MS));
      if (!polling) break;
      try {
        const { stdout } = await run(adbPath, ['-s', deviceUdid, 'shell', 'stat', '-c', '%s', remotePath], {
          timeout: ADB_SHORT_TIMEOUT_MS,
        });
        const landed = Number(stdout.trim());
        if (Number.isFinite(landed) && landed > 0) onProgress(landed, totalBytes);
      } catch {
        // The file may not exist yet, or adb may be busy with the push —
        // neither is a failure of the push itself, so keep polling.
      }
    }
  })();

  try {
    await push;
  } finally {
    polling = false;
    await poll;
  }
}

/**
 * Downloads one build artifact and installs it onto the device that requested
 * it, reporting status back to the hub at each step.
 *
 * The install is split into three phases so that progress is honest rather
 * than approximated: the HTTP download and the device push are both measured
 * in real bytes, and only `pm install` — which does dexopt and exposes no byte
 * ratio — is left indeterminate. Collapsing all three into one `adb install -r`
 * (the previous implementation) meant the single longest phase reported
 * nothing at all.
 *
 * iOS has no real path on this codebase yet — no Mac, no `ios-deploy` — so it
 * reports a clear error instead of silently no-opping.
 */
export async function runInstall(
  hub: HubClient,
  pending: PendingInstall,
  adbPath = process.env.ADB_PATH ?? 'adb',
): Promise<void> {
  const { installRunId, deviceUdid, buildId, platform, sizeBytes } = pending;

  if (platform === 'ios') {
    await hub.reportInstallProgress(installRunId, deviceUdid, {
      status: 'error',
      error: 'iOS install is not implemented on this agent (no ios-deploy / no macOS host available).',
    });
    return;
  }

  const destPath = path.join(os.tmpdir(), 'mobile-hub-installs', `${installRunId}-${deviceUdid}.apk`);
  const remotePath = `${REMOTE_STAGING_DIR}/mobile-hub-${installRunId}-${deviceUdid}.apk`;
  fs.mkdirSync(path.dirname(destPath), { recursive: true });

  try {
    await hub.reportInstallProgress(installRunId, deviceUdid, { status: 'downloading', progress: 0 });
    const onDownload = throttledReporter(hub, installRunId, deviceUdid, 'downloading');
    await hub.downloadArtifact(buildId, destPath, (done, total) =>
      // Prefer the size the hub told us over Content-Length: a proxy using
      // chunked encoding drops the header, and the hub always knows the size.
      onDownload(done, total ?? sizeBytes),
    );

    const localSize = fs.statSync(destPath).size;
    await hub.reportInstallProgress(installRunId, deviceUdid, { status: 'transferring', progress: 0 });
    const onPush = throttledReporter(hub, installRunId, deviceUdid, 'transferring');
    await pushToDevice(adbPath, deviceUdid, destPath, remotePath, localSize, onPush);

    // dexopt has no byte ratio, so progress deliberately stops moving here and
    // the phase label carries the meaning instead. Inventing a rising number
    // through this phase would be the same class of lie the byte counting
    // above exists to remove.
    await hub.reportInstallProgress(installRunId, deviceUdid, { status: 'installing', progress: 100 });
    const { stdout } = await run(adbPath, ['-s', deviceUdid, 'shell', 'pm', 'install', '-r', remotePath], {
      timeout: ADB_INSTALL_TIMEOUT_MS,
    });
    // `pm install` reports failure on stdout with a zero exit code, so the
    // exit code alone would let a failed install be recorded as done.
    if (!/^Success/m.test(stdout)) {
      throw new Error(`pm install did not report success: ${stdout.trim() || '(no output)'}`);
    }

    await hub.reportInstallProgress(installRunId, deviceUdid, { status: 'done', progress: 100 });
  } catch (err) {
    await hub.reportInstallProgress(installRunId, deviceUdid, {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    fs.rm(destPath, { force: true }, () => {
      // Best-effort cleanup — a leftover temp APK is a disk-space nuisance,
      // not a correctness problem.
    });
    // The staged copy on the device is the same kind of nuisance, and leaving
    // one per install would fill /data/local/tmp over time.
    void run(adbPath, ['-s', deviceUdid, 'shell', 'rm', '-f', remotePath], {
      timeout: ADB_SHORT_TIMEOUT_MS,
    }).catch(() => {});
  }
}
