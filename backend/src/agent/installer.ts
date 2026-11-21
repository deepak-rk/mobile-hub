import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HubClient, PendingInstall } from './hub-client';

const run = promisify(execFile);
/** `run`'s call shape, factored out so a test can inject a fake without mocking `child_process`/`promisify` itself. */
type Runner = (command: string, args: string[], options: { timeout: number }) => Promise<{ stdout: string; stderr: string }>;
const ADB_INSTALL_TIMEOUT_MS = 120_000;
const ADB_PUSH_TIMEOUT_MS = 300_000;
const ADB_SHORT_TIMEOUT_MS = 10_000;
/** Matches the ~1s cadence docs/modules/builds.md specifies for download progress. */
const PROGRESS_REPORT_INTERVAL_MS = 1000;
/** Where the artifact is staged on the device before `pm install` reads it. */
const REMOTE_STAGING_DIR = '/data/local/tmp';
/**
 * Where builds are cached on this agent's own disk, keyed by build id, so a
 * repeat install (a different device on this host, or a re-install after the
 * agent restarted) skips re-downloading a build it already fetched. No
 * eviction yet — a first pass, and the failure mode of not having one is disk
 * space, not correctness; add a bound or an LRU sweep once real usage shows
 * it's needed.
 */
const CACHE_DIR = path.join(os.homedir(), '.mobile-hub-agent', 'builds');

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
 * Parses `pm list packages [--show-versioncode]` into name -> version code.
 *
 * Exported for testing: this is the part that actually breaks, since the
 * output shape varies by Android version and a misparse would make every
 * package look changed (or none). Version code is `null` when the device's
 * `pm` is too old for `--show-versioncode` (added in API 28), which callers
 * must treat as "unknown", not "unchanged".
 */
export function parsePackageList(stdout: string): Map<string, string | null> {
  const packages = new Map<string, string | null>();
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('package:')) continue;
    // `package:com.example.app versionCode:42` — the version suffix is absent
    // on older devices, and an APK path can appear instead with `-f`, which
    // this never passes.
    const [nameToken, ...rest] = trimmed.slice('package:'.length).split(/\s+/);
    if (!nameToken) continue;
    const versionToken = rest.find((t) => t.startsWith('versionCode:'));
    packages.set(nameToken, versionToken ? versionToken.slice('versionCode:'.length) : null);
  }
  return packages;
}

/**
 * Which package an install actually changed, by diffing the package table
 * either side of it.
 *
 * There is no dependency-free way to read a package name out of an APK — the
 * manifest inside is binary AXML and `aapt` is not guaranteed present — so the
 * device is asked instead. A package that is newly present, or whose version
 * code moved, is positively identified as the one just installed.
 *
 * Returns null when nothing changed, which is a real and common case rather
 * than a failure: `pm install -r` reinstalling the *same* version of an
 * already-present package leaves the table identical. That is indistinguishable
 * here from "nothing happened", so it is reported as unknown rather than
 * guessed at — see the caller for what it does with that.
 */
export function identifyInstalledPackage(
  before: Map<string, string | null>,
  after: Map<string, string | null>,
): string | null {
  const changed: string[] = [];
  for (const [name, version] of after) {
    if (!before.has(name)) {
      changed.push(name);
      continue;
    }
    const previous = before.get(name) ?? null;
    // Both null means the device can't report version codes at all; that is
    // not evidence of a change.
    if (version !== null && previous !== null && version !== previous) changed.push(name);
  }
  // More than one changed means something else installed concurrently, so no
  // single candidate can be attributed to this run.
  return changed.length === 1 ? changed[0] : null;
}

async function listInstalledPackages(adbPath: string, deviceUdid: string): Promise<Map<string, string | null>> {
  try {
    const { stdout } = await run(
      adbPath,
      ['-s', deviceUdid, 'shell', 'pm', 'list', 'packages', '--show-versioncode'],
      { timeout: ADB_SHORT_TIMEOUT_MS },
    );
    return parsePackageList(stdout);
  } catch {
    // `--show-versioncode` is API 28+; fall back to names only rather than
    // losing the new-package signal entirely on an older device.
    try {
      const { stdout } = await run(adbPath, ['-s', deviceUdid, 'shell', 'pm', 'list', 'packages'], {
        timeout: ADB_SHORT_TIMEOUT_MS,
      });
      return parsePackageList(stdout);
    } catch {
      // A device that won't list packages can't be verified against; an empty
      // map makes `identifyInstalledPackage` return null, which the caller
      // reports as unverified rather than as success.
      return new Map();
    }
  }
}

/**
 * Confirms the package the install just changed is genuinely installed.
 *
 * `pm install` printing `Success` says the transaction was accepted; asking
 * the package manager where the app now lives is what proves it is really
 * there. Throws when a positively-identified package has no path, which is the
 * one case that is unambiguously a failed install reported as a success — the
 * reference platform had no such check and this one should not inherit that.
 *
 * A check that could not run at all (adb timed out, device dropped off the
 * bus) proves nothing either way, and `pm install` already said `Success` — so
 * that is "unverified", not "failed". It resolves to a warning message for the
 * caller to attach to the `done` report instead of throwing, which would have
 * marked a working install as an error. Resolves to null when verified.
 */
export async function verifyPackageInstalled(
  adbPath: string,
  deviceUdid: string,
  packageName: string,
  runFn: Runner = run,
): Promise<string | null> {
  let stdout: string;
  try {
    ({ stdout } = await runFn(adbPath, ['-s', deviceUdid, 'shell', 'pm', 'path', packageName], {
      timeout: ADB_SHORT_TIMEOUT_MS,
    }));
  } catch (err) {
    return `Installed, but could not verify ${packageName} on ${deviceUdid}: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (!/^package:/m.test(stdout)) {
    throw new Error(
      `pm install reported success but ${packageName} has no installed path on ${deviceUdid} — the install did not take`,
    );
  }
  return null;
}

/**
 * Parses `adb shell dumpsys package <name>`'s "runtime permissions:" block
 * into the names still ungranted.
 *
 * This targets Android's own **runtime/dangerous** permission group
 * specifically — the one `pm grant` can actually act on (a normal or
 * signature permission is auto-granted at install time and doesn't appear in
 * this block at all, so there's nothing to filter by "dangerous" beyond
 * reading the block dumpsys already separates out). Deliberately not parsed
 * from the APK itself via `aapt`: that tool is not guaranteed present on this
 * agent (`identifyInstalledPackage`'s own doc comment already established
 * this for the same reason) — the device, not the artifact, is the source of
 * truth here, same as everywhere else in this file.
 *
 * Exported for testing: dumpsys's exact per-line shape (trailing flags after
 * `granted=`) is the part most likely to drift across Android versions.
 */
export function parseUngrantedRuntimePermissions(dumpsysOutput: string): string[] {
  const lines = dumpsysOutput.split(/\r?\n/);
  const startIdx = lines.findIndex((l) => /runtime permissions:\s*$/i.test(l.trim()));
  if (startIdx === -1) return [];

  const permissions: string[] = [];
  // A permission entry always looks like `name: granted=true|false[, ...]`;
  // the first line that doesn't match ends the block, since dumpsys nests
  // strictly by section rather than by an explicit terminator.
  const entry = /^([\w.]+):\s*granted=(true|false)/;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const match = lines[i].trim().match(entry);
    if (!match) break;
    const [, name, granted] = match;
    if (granted === 'false') permissions.push(name);
  }
  return permissions;
}

/**
 * Best-effort: grants every declared-but-ungranted runtime permission via
 * `pm grant`.
 *
 * Never throws. This runs after a real, successful, verified install — an
 * individual permission failing to grant (already handled elsewhere, or a
 * device that refuses it for its own reasons) is a secondary enhancement not
 * landing, not a reason to report the install itself as failed. Even being
 * unable to read the permission list at all is swallowed the same way.
 */
export async function grantRuntimePermissions(
  adbPath: string,
  deviceUdid: string,
  packageName: string,
  runFn: Runner = run,
): Promise<{ granted: string[]; failed: string[] }> {
  const granted: string[] = [];
  const failed: string[] = [];
  try {
    const { stdout } = await runFn(adbPath, ['-s', deviceUdid, 'shell', 'dumpsys', 'package', packageName], {
      timeout: ADB_SHORT_TIMEOUT_MS,
    });
    for (const permission of parseUngrantedRuntimePermissions(stdout)) {
      try {
        await runFn(adbPath, ['-s', deviceUdid, 'shell', 'pm', 'grant', packageName, permission], {
          timeout: ADB_SHORT_TIMEOUT_MS,
        });
        granted.push(permission);
      } catch {
        failed.push(permission);
      }
    }
  } catch {
    // Couldn't even read the permission list — nothing to grant. The install
    // this follows already succeeded and stays that way.
  }
  return { granted, failed };
}

/**
 * Dedupes concurrent downloads of the same build.
 *
 * `agent.ts#startPendingInstalls` fires one `runInstall` per pending target
 * without awaiting the others — installing one build onto several devices on
 * this host is exactly this case, several targets sharing one `buildId`. Without
 * this, every one of them would race to write the same cached file at once.
 * Keyed by `buildId`, process-local: this is agent-local disk state, not
 * something another machine could race against, so an in-memory map is enough.
 */
const downloadsInFlight = new Map<string, Promise<void>>();

/**
 * Exported for testing: the part that decides whether a re-download is
 * skipped. `cacheDir` defaults to the real per-agent cache and is only ever
 * overridden by tests, to a temp directory — never by `runInstall` itself.
 */
export function cachedBuildPath(buildId: string, cacheDir: string = CACHE_DIR): string {
  // Every path through this agent only ever installs Android — iOS returns
  // early in `runInstall` before this is ever called — so `.apk` is safe here
  // the same way it was already hardcoded in the old temp-file destination.
  return path.join(cacheDir, `${buildId}.apk`);
}

/**
 * Whether a cached copy is present *and verified* against the size the hub
 * reports — a cached file is never trusted blindly. `sizeBytes: null` (the hub
 * doesn't know the size) means the cache can't be verified, so it's treated as
 * a miss rather than an unverified hit; better to re-download than to risk
 * pushing a stale or corrupt file to a device.
 */
export function isCacheValid(buildId: string, sizeBytes: number | null, cacheDir: string = CACHE_DIR): boolean {
  if (sizeBytes == null) return false;
  try {
    return fs.statSync(cachedBuildPath(buildId, cacheDir)).size === sizeBytes;
  } catch {
    return false;
  }
}

/**
 * Whether a build's origin is worth the agent trying to fetch directly,
 * skipping the hub as a byte proxy.
 *
 * Only a plain `http(s)://` URL qualifies. A `file://` source names a path on
 * the *hub's* own disk — this agent has no way to read it, and treating it as
 * fetchable would just fail every time before falling back anyway. Anything
 * else (an empty/missing `artifactUrl`, a scheme this agent doesn't
 * recognize) is the same "not attemptable" case.
 */
function isDirectlyFetchable(artifactUrl: string | null): artifactUrl is string {
  return artifactUrl !== null && /^https?:\/\//i.test(artifactUrl);
}

/**
 * Returns a local path holding a verified copy of this build, downloading it
 * only if the cache doesn't already have one.
 *
 * Tries the build's original source directly first when one is reachable
 * (`isDirectlyFetchable`) — the hub only orchestrates in that case, never
 * proxying the transfer. Any failure on that path (network error, non-200,
 * an origin this agent's network can't reach) falls back to the existing
 * via-hub download rather than failing the install outright — the direct
 * path is an optimization, not a requirement; a build only reachable through
 * the hub must keep working exactly as it did before this existed.
 */
export async function ensureCachedBuild(
  hub: HubClient,
  buildId: string,
  sizeBytes: number | null,
  onProgress: (done: number, total: number | null) => void,
  cacheDir: string = CACHE_DIR,
  artifactUrl: string | null = null,
): Promise<string> {
  const dest = cachedBuildPath(buildId, cacheDir);
  if (isCacheValid(buildId, sizeBytes, cacheDir)) {
    onProgress(sizeBytes ?? 0, sizeBytes);
    return dest;
  }

  const existing = downloadsInFlight.get(buildId);
  if (existing) {
    await existing;
    // The download this awaited may have been started for a different caller
    // — re-validate rather than assume its result satisfies this one too.
    if (!isCacheValid(buildId, sizeBytes, cacheDir)) {
      throw new Error(`Cached build ${buildId} failed validation after a shared in-flight download.`);
    }
    // A caller that only waited on someone else's download never saw its
    // byte-level progress; report completion rather than leaving it at 0.
    onProgress(sizeBytes ?? 0, sizeBytes);
    return dest;
  }

  fs.mkdirSync(cacheDir, { recursive: true });
  const download = (async () => {
    if (isDirectlyFetchable(artifactUrl)) {
      try {
        await hub.downloadArtifactDirect(artifactUrl, dest, onProgress);
        return;
      } catch {
        // Optimization failed — fall through to the hub, which must still work.
      }
    }
    await hub.downloadArtifact(buildId, dest, onProgress);
  })();
  downloadsInFlight.set(buildId, download);
  try {
    await download;
  } finally {
    downloadsInFlight.delete(buildId);
  }
  return dest;
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
  const { installRunId, deviceUdid, buildId, platform, sizeBytes, artifactUrl } = pending;

  if (platform === 'ios') {
    await hub.reportInstallProgress(installRunId, deviceUdid, {
      status: 'error',
      error: 'iOS install is not implemented on this agent (no ios-deploy / no macOS host available).',
    });
    return;
  }

  const remotePath = `${REMOTE_STAGING_DIR}/mobile-hub-${installRunId}-${deviceUdid}.apk`;

  try {
    await hub.reportInstallProgress(installRunId, deviceUdid, { status: 'downloading', progress: 0 });
    const onDownload = throttledReporter(hub, installRunId, deviceUdid, 'downloading');
    // Prefer the size the hub told us over Content-Length: a proxy using
    // chunked encoding drops the header, and the hub always knows the size.
    // Also what makes the cache verifiable — see `isCacheValid`.
    const destPath = await ensureCachedBuild(
      hub,
      buildId,
      sizeBytes,
      (done, total) => onDownload(done, total ?? sizeBytes),
      undefined,
      artifactUrl,
    );

    const localSize = fs.statSync(destPath).size;
    await hub.reportInstallProgress(installRunId, deviceUdid, { status: 'transferring', progress: 0 });
    const onPush = throttledReporter(hub, installRunId, deviceUdid, 'transferring');
    await pushToDevice(adbPath, deviceUdid, destPath, remotePath, localSize, onPush);

    // Snapshotted before the install so the diff afterwards can name the
    // package that changed — the APK itself cannot be asked without aapt.
    const packagesBefore = await listInstalledPackages(adbPath, deviceUdid);

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

    // `Success` means the transaction was accepted; this asks the package
    // manager whether the app is actually there. Only a positively identified
    // package can be checked — a same-version reinstall leaves the package
    // table untouched and so cannot be attributed to this run. That case is
    // left unverified rather than passed off as verified, because a check that
    // silently no-ops is worse than no check: it reads as a guarantee.
    const installedPackage = identifyInstalledPackage(
      packagesBefore,
      await listInstalledPackages(adbPath, deviceUdid),
    );
    const verifyWarning = installedPackage ? await verifyPackageInstalled(adbPath, deviceUdid, installedPackage) : null;

    // Org opt-in (off by default) and Android-only, and only meaningful once
    // a package has been positively identified — a same-version reinstall
    // that left nothing to attribute has nothing here to grant permissions
    // to either. Never fails the install: see grantRuntimePermissions's own
    // doc comment.
    if (pending.grantPermissions && installedPackage) {
      await hub.reportInstallProgress(installRunId, deviceUdid, { status: 'granting-permissions', progress: 100 });
      await grantRuntimePermissions(adbPath, deviceUdid, installedPackage);
    }

    await hub.reportInstallProgress(installRunId, deviceUdid, {
      status: 'done',
      progress: 100,
      ...(installedPackage ? { packageName: installedPackage } : {}),
      // The target schema has no separate warning field; `error` on a `done`
      // target carries a non-fatal note (here: verification could not run).
      ...(verifyWarning ? { error: verifyWarning } : {}),
    });
  } catch (err) {
    await hub.reportInstallProgress(installRunId, deviceUdid, {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    // The downloaded artifact is no longer cleaned up here — it lives in the
    // persistent per-build cache now (`ensureCachedBuild`), kept across
    // installs on purpose. Only the device-side staged copy is this run's own
    // mess to clean up; leaving one per install would fill /data/local/tmp.
    void run(adbPath, ['-s', deviceUdid, 'shell', 'rm', '-f', remotePath], {
      timeout: ADB_SHORT_TIMEOUT_MS,
    }).catch(() => {});
  }
}
