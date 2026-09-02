import { EffectiveConfig } from '../../config/org-config.schema';
import * as supervisor from '../../common/process-supervisor';
import { ManagedProcess } from '../../common/process-supervisor';
import { Device, IDevice } from '../devices/device.model';
import { buildRunEnvironment } from './run-environment';

/**
 * Ensures an Appium server exists for a device, and tells a run where it is.
 *
 * Until this existed, `execution` could clone a repo, install its dependencies
 * and invoke a runner — but the runner had nothing to connect to unless
 * someone had started a server by hand. That was the last gap between running
 * a command and running a mobile test.
 *
 * Servers are per **device**, not per run: a run that started its own would
 * pay Appium's startup cost every time, and two runs on different devices
 * would fight over one port. This mirrors the sibling appium-server-setup
 * repo's core rule — one process per device, and a server's lifetime is longer
 * than any single suite's.
 */

export class AppiumUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppiumUnavailableError';
  }
}

export interface AppiumEndpoint {
  host: string;
  port: number;
  baseUrl: string;
}

/** Live servers this process started, keyed by udid, so they are reused and can be shut down. */
const servers = new Map<string, ManagedProcess>();

const STATUS_TIMEOUT_MS = 2000;
const STARTUP_TIMEOUT_MS = 60_000;
const STARTUP_POLL_MS = 500;
/**
 * How long to wait for a port-holder to start answering as Appium before
 * giving up on adopting it. Shorter than STARTUP_TIMEOUT_MS because by this
 * point something is already listening — this is waiting out the tail of
 * someone else's boot, not a boot from nothing.
 */
const ADOPT_TIMEOUT_MS = 30_000;

/**
 * The port this device's server uses, assigned once and then remembered.
 *
 * Allocation happens exactly once per device and is persisted on the device
 * record. The sibling repo argues the case: a port picked fresh each time can
 * leak or race and needs a reconciler to self-heal, while one that is written
 * down cannot. Devices here are discovered rather than hand-enumerated, so the
 * hub writes the assignment down instead of a human doing it.
 */
async function ensurePort(device: IDevice, config: EffectiveConfig): Promise<number> {
  if (device.appiumPort) return device.appiumPort;

  // Lowest free port at or above the base. Reads committed assignments rather
  // than counting devices, so removing a device frees its port for reuse and
  // never shifts anyone else's.
  const taken = new Set(
    (await Device.find({ appiumPort: { $ne: null } }).select('appiumPort')).map((d) => d.appiumPort),
  );
  let port = config.appium.basePort;
  while (taken.has(port)) port += 1;

  // Conditional write: two runs starting together must not be handed the same
  // port because both read the same "free" set a moment apart.
  const claimed = await Device.findOneAndUpdate(
    { _id: device._id, appiumPort: null },
    { appiumPort: port },
    { new: true },
  );
  // Lost the race — the winner's assignment is authoritative.
  return claimed?.appiumPort ?? (await Device.findById(device._id))?.appiumPort ?? port;
}

/**
 * The Appium driver a device's platform needs before a session can start.
 *
 * Checked up front because the alternative is what actually happened here: a
 * run cloned a repo, installed its dependencies and started a runner, and only
 * then discovered — two minutes in — that no driver could serve
 * `automationName: UiAutomator2`. That is the bounded fail-fast preflight the
 * sibling appium-server-setup repo argues for, applied to the one prerequisite
 * this hub can check cheaply.
 */
const REQUIRED_DRIVER: Record<string, string> = { android: 'uiautomator2', ios: 'xcuitest' };

export async function assertDriverInstalled(platform: string): Promise<void> {
  const driver = REQUIRED_DRIVER[platform];
  if (!driver) return;

  let output = '';
  const collect = (chunk: Buffer): void => {
    output += chunk.toString();
  };
  // Both streams: `appium driver list` prints its table to stderr.
  const listed = supervisor.run({
    command: 'appium',
    args: ['driver', 'list', '--installed'],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH, APPDATA: process.env.APPDATA, USERPROFILE: process.env.USERPROFILE },
    timeoutMs: 30_000,
    onStdout: collect,
    onStderr: collect,
  });
  await listed.result;

  if (!output.includes(driver)) {
    throw new AppiumUnavailableError(
      `Appium has no '${driver}' driver installed, which ${platform} sessions require. ` +
        `Install it with \`appium driver install ${driver}\`. ` +
        `Note the driver's major must match the Appium server's — a current driver requires Appium 3.x.`,
    );
  }
}

/** Whether something is already answering as Appium on this endpoint. */
async function isServerUp(endpoint: AppiumEndpoint): Promise<boolean> {
  try {
    const res = await fetch(`${endpoint.baseUrl}/status`, { signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Returns a running server's endpoint for this device, starting one if needed.
 *
 * An already-listening server is adopted rather than replaced — an org running
 * its own Appium fleet on the configured ports should have the hub use it, not
 * fight it.
 */
export async function ensureAppiumServer(device: IDevice, config: EffectiveConfig): Promise<AppiumEndpoint> {
  const port = await ensurePort(device, config);
  const host = config.appium.host;
  const endpoint: AppiumEndpoint = { host, port, baseUrl: `http://${host}:${port}` };

  if (await isServerUp(endpoint)) return endpoint;

  // A tracked process that is no longer answering has died; drop it so a fresh
  // one can take the port.
  servers.delete(device.udid);

  // Kept so a server that dies during startup can say why. Without this the
  // only symptom was "did not become ready", which names a timeout rather than
  // a cause and leaves nothing to act on.
  let startupOutput = '';
  const collect = (chunk: Buffer): void => {
    // Bounded: Appium is chatty, and only the beginning matters for a failure
    // to start.
    if (startupOutput.length < 4000) startupOutput += chunk.toString();
  };

  const managed = supervisor.run({
    command: 'appium',
    args: [
      '--address',
      host,
      '--port',
      String(port),
      '--base-path',
      '/',
      // Only this device may be driven by this server, which is what makes
      // one-process-per-device a boundary rather than a convention.
      '--default-capabilities',
      JSON.stringify({ 'appium:udid': device.udid }),
    ],
    cwd: process.cwd(),
    // The server spawns adb itself, so it needs the SDK root as much as the
    // runner does — derived the same way rather than assumed to be exported.
    env: buildRunEnvironment({ configured: {} }),
    onStdout: collect,
    onStderr: collect,
  });
  servers.set(device.udid, managed);

  // If it exits during startup, stop waiting on a poll that can never succeed.
  let exited = false;
  void managed.result.then(() => {
    exited = true;
    servers.delete(device.udid);
  });

  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited) break;
    await new Promise((r) => setTimeout(r, STARTUP_POLL_MS));
    if (await isServerUp(endpoint)) return endpoint;
  }

  managed.cancel();
  servers.delete(device.udid);

  const detail = startupOutput.trim();

  // A port already held is not the same as a server already up, and the gap
  // between the two is a window this hub opens itself: the servers map lives
  // in process memory, so a backend restart orphans a running Appium, and a
  // run starting while that orphan is still booting sees /status silent and
  // the port taken. Waiting it out adopts the orphan instead of failing on it,
  // which is the same adopt-don't-fight rule as the check at the top — that
  // one just could not see a server that had not opened its API yet.
  if (detail.includes('EADDRINUSE')) {
    const adoptDeadline = Date.now() + ADOPT_TIMEOUT_MS;
    while (Date.now() < adoptDeadline) {
      await new Promise((r) => setTimeout(r, STARTUP_POLL_MS));
      if (await isServerUp(endpoint)) return endpoint;
    }
    throw new AppiumUnavailableError(
      `Port ${port} on ${host} is held by something that never answered as Appium ` +
        `(waited ${ADOPT_TIMEOUT_MS / 1000}s after EADDRINUSE). ` +
        `That is usually an Appium this hub started before a restart, now orphaned, or another program on the port. ` +
        `Free the port, or move this device off it by clearing its appiumPort.`,
    );
  }

  throw new AppiumUnavailableError(
    (exited
      ? `Appium exited during startup on ${endpoint.baseUrl}.`
      : `Appium did not become ready on ${endpoint.baseUrl} within ${STARTUP_TIMEOUT_MS / 1000}s.`) +
      ` Check that \`appium\` is installed and on PATH, and that port ${port} is free.` +
      // The server's own words beat any guess this layer could make about why.
      (detail ? `\nAppium said:\n${detail}` : '\nAppium produced no output before failing.'),
  );
}

/**
 * Stops every server this process started.
 *
 * Called on shutdown for the same reason streaming tears down its captures: a
 * child holding a device must not outlive the hub that started it.
 */
export async function shutdownAppiumServers(): Promise<void> {
  const running = [...servers.values()];
  servers.clear();
  for (const managed of running) managed.cancel();
  await Promise.all(running.map((m) => m.result));
}
