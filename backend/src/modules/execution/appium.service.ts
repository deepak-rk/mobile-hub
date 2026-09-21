import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EffectiveConfig } from '../../config/org-config.schema';
import * as supervisor from '../../common/process-supervisor';
import { ManagedProcess } from '../../common/process-supervisor';
import { Device, IDevice } from '../devices/device.model';
import { buildRunEnvironment } from './run-environment';

/**
 * Writes `--default-capabilities`' JSON to a temp file and returns its path,
 * rather than passing the JSON inline as an argument — found live 2026-09-21:
 * on Windows, `appium` resolves to a `.cmd` shim, which (since
 * `process-supervisor.ts`'s own Node-version-driven fix requires `shell: true`
 * for any resolved `.cmd`/`.bat`) is now spawned through `cmd.exe`, whose own
 * argument re-quoting strips the double quotes out of an inline JSON string —
 * `{"appium:udid":"d1"}` arrived at Appium as `{appium:udid:d1}`, invalid on
 * its face. Appium's CLI accepts a file path here as well as an inline
 * string; a path has no characters cmd.exe's quoting can mangle, so this
 * sidesteps the problem entirely rather than trying to out-escape it.
 */
function writeDefaultCapabilitiesFile(udid: string): string {
  const file = path.join(os.tmpdir(), `mh-appium-caps-${udid.replace(/[^a-zA-Z0-9-]/g, '_')}.json`);
  fs.writeFileSync(file, JSON.stringify({ 'appium:udid': udid }));
  return file;
}

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

/**
 * Live servers this process started, keyed by `machineId:udid` so they are
 * reused and can be shut down. Not by udid alone: the device model's own
 * compound `{machineId, udid}` index exists because the same UDID can appear
 * on two different hosts (routine for emulators, whose udids are just
 * `emulator-<port>`) — a udid-only key would let two unrelated devices
 * collide in this map.
 */
const servers = new Map<string, ManagedProcess>();

function serverKey(device: IDevice): string {
  return `${device.machineId}:${device.udid}`;
}

const STATUS_TIMEOUT_MS = 2000;
const STARTUP_TIMEOUT_MS = 60_000;
const STARTUP_POLL_MS = 500;
/**
 * How long to keep retrying while the port is held by something that is not
 * answering as Appium — a holder either finishing its boot or finishing its
 * shutdown. Bounded: past this it is not contention, it is a program that owns
 * the port and is not going to give it back.
 */
const PORT_CONTENTION_TIMEOUT_MS = 45_000;
const PORT_RETRY_DELAY_MS = 2000;

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

/**
 * This hub always spawns its own servers with `--base-path /`, but
 * `ensureAppiumServer`'s adopt-don't-replace path can hand back a server this
 * hub never started — an org's own Appium fleet, commonly still run under the
 * legacy `/wd/hub` prefix inherited from the old JSONWP/Selenium Grid
 * convention. Every base path Appium is known to run under, most specific
 * first so a server answering both isn't miscategorized.
 */
const APPIUM_BASE_PATHS = ['', '/wd/hub'];

/**
 * Which base path (if any) this endpoint is actually answering `/status`
 * requests on. `null` means neither responded — same technique a real
 * device-farm's own health check already used for exactly this cross-version
 * gap: probe every known path and use whichever one returns a value.
 */
async function resolveAppiumPrefix(baseUrl: string): Promise<string | null> {
  for (const prefix of APPIUM_BASE_PATHS) {
    try {
      const res = await fetch(`${baseUrl}${prefix}/status`, { signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) });
      if (res.ok) return prefix;
    } catch {
      // A refused connection or timeout on one base path says nothing about
      // whether the other one would answer — keep trying.
    }
  }
  return null;
}

/** Whether something is already answering as Appium on this endpoint. */
async function isServerUp(endpoint: AppiumEndpoint): Promise<boolean> {
  return (await resolveAppiumPrefix(endpoint.baseUrl)) !== null;
}

/**
 * One attempt at starting a server, reported rather than thrown.
 *
 * `portBusy` is its own outcome because it is the one failure worth retrying:
 * everything else (no `appium` on PATH, a driver that will not load) fails the
 * same way however many times it is tried.
 */
type StartOutcome =
  | { kind: 'started' }
  | { kind: 'port-busy' }
  | { kind: 'failed'; exited: boolean; detail: string };

async function startServer(device: IDevice, endpoint: AppiumEndpoint): Promise<StartOutcome> {
  // A tracked process that is no longer answering has died; drop it so a fresh
  // one can take the port.
  servers.delete(serverKey(device));

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
      endpoint.host,
      '--port',
      String(endpoint.port),
      '--base-path',
      '/',
      // Only this device may be driven by this server, which is what makes
      // one-process-per-device a boundary rather than a convention.
      '--default-capabilities',
      writeDefaultCapabilitiesFile(device.udid),
    ],
    cwd: process.cwd(),
    // The server spawns adb itself, so it needs the SDK root as much as the
    // runner does — derived the same way rather than assumed to be exported.
    env: buildRunEnvironment({ configured: {} }),
    onStdout: collect,
    onStderr: collect,
  });
  servers.set(serverKey(device), managed);

  // If it exits during startup, stop waiting on a poll that can never succeed.
  let exited = false;
  void managed.result.then(() => {
    exited = true;
    servers.delete(serverKey(device));
  });

  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited) break;
    await new Promise((r) => setTimeout(r, STARTUP_POLL_MS));
    if (await isServerUp(endpoint)) return { kind: 'started' };
  }

  managed.cancel();
  servers.delete(serverKey(device));

  const detail = startupOutput.trim();
  if (detail.includes('EADDRINUSE')) return { kind: 'port-busy' };
  return { kind: 'failed', exited, detail };
}

/**
 * Returns a running server's endpoint for this device, starting one if needed.
 *
 * An already-listening server is adopted rather than replaced — an org running
 * its own Appium fleet on the configured ports should have the hub use it, not
 * fight it.
 *
 * The retry loop exists because a port being *held* is neither "free" nor
 * "ready", and the hub creates that third state itself: the `servers` map is
 * process memory, so a restart orphans a running Appium. A run arriving during
 * that window finds `/status` silent and the port taken, and the holder is
 * equally likely to be **booting** (so wait and adopt it) or **dying** (so wait
 * and take the port). Only retrying the whole attempt covers both; polling
 * `/status` alone covers only the first, and that was the bug — the first run
 * after a backend restart failed against a server that was on its way out.
 */
export async function ensureAppiumServer(device: IDevice, config: EffectiveConfig): Promise<AppiumEndpoint> {
  // Devices are always agent-owned in this architecture — a hub-local spawn
  // only actually works today because the dev agent happens to run on the
  // same box as the hub, sharing its adb/USB access by accident, not by
  // design. `remoteEnabled` is the opt-in switch to the *correct* path (the
  // owning agent spawns its own Appium and the hub relays), left off by
  // default so today's single-machine behavior is unchanged until proven —
  // see docs/reference-review-2026-09-14/01-architecture-findings.md §1.3.
  if (config.appium.remoteEnabled) return ensureRemoteAppiumServer(device, config);

  const port = await ensurePort(device, config);
  const host = config.appium.host;
  const endpoint: AppiumEndpoint = { host, port, baseUrl: `http://${host}:${port}` };

  const contendedUntil = Date.now() + PORT_CONTENTION_TIMEOUT_MS;
  for (;;) {
    if (await isServerUp(endpoint)) return endpoint;

    const outcome = await startServer(device, endpoint);
    if (outcome.kind === 'started') return endpoint;

    if (outcome.kind === 'port-busy') {
      if (Date.now() < contendedUntil) {
        await new Promise((r) => setTimeout(r, PORT_RETRY_DELAY_MS));
        continue;
      }
      throw new AppiumUnavailableError(
        `Port ${port} on ${host} stayed busy for ${PORT_CONTENTION_TIMEOUT_MS / 1000}s without ever ` +
          `answering as Appium. That is usually an Appium this hub started before a restart, now ` +
          `orphaned, or another program holding the port. Free it, or move this device off it by ` +
          `clearing its appiumPort.`,
      );
    }

    throw new AppiumUnavailableError(
      (outcome.exited
        ? `Appium exited during startup on ${endpoint.baseUrl}.`
        : `Appium did not become ready on ${endpoint.baseUrl} within ${STARTUP_TIMEOUT_MS / 1000}s.`) +
        ` Check that \`appium\` is installed and on PATH, and that port ${port} is free.` +
        // The server's own words beat any guess this layer could make about why.
        (outcome.detail ? `\nAppium said:\n${outcome.detail}` : '\nAppium produced no output before failing.'),
    );
  }
}

const REMOTE_REQUEST_TIMEOUT_MS = STARTUP_TIMEOUT_MS; // same startup budget the hub gives its own local spawn
const REMOTE_POLL_MS = 1000;

/**
 * The remote counterpart to `ensureAppiumServer`'s hub-local path: instead of
 * spawning Appium itself, the hub asks the device's *owning agent* to spawn
 * (or adopt) its own local Appium server, and relays that endpoint to the
 * caller once the agent reports it. This is what makes a device on a remote
 * host actually testable — adb/xcrun need to run beside the device, and only
 * the agent is ever beside it.
 *
 * The "ask" is a request recorded on the device record
 * (`remoteAppiumRequestedAt`) — discovered by the agent on its own next
 * heartbeat poll, same never-pushed-into shape already proven for installs
 * and uninstalls — not a direct call into the agent, which this hub has no
 * way to make (agents are never listening for inbound connections).
 *
 * An already-reported endpoint is health-checked before being trusted, not
 * assumed live — the agent's server can die or restart between one run and
 * the next the same way a hub-local one can (see `ensureAppiumServer`'s own
 * doc comment for why "reported once" and "healthy now" are different
 * claims). A stale one is cleared and re-requested rather than handed to a
 * caller that would just fail against it.
 */
export async function ensureRemoteAppiumServer(device: IDevice, _config: EffectiveConfig): Promise<AppiumEndpoint> {
  if (device.remoteAppium) {
    const endpoint: AppiumEndpoint = {
      host: device.remoteAppium.host,
      port: device.remoteAppium.port,
      baseUrl: `http://${device.remoteAppium.host}:${device.remoteAppium.port}`,
    };
    if (await isServerUp(endpoint)) return endpoint;
    await Device.findByIdAndUpdate(device._id, { remoteAppium: null });
  }

  // Idempotent to set repeatedly — a run that arrives while another is
  // already waiting just refreshes the timestamp, it doesn't fork a second
  // request; the agent only ever reports one endpoint per device regardless
  // of how many times this fired.
  await Device.findByIdAndUpdate(device._id, { remoteAppiumRequestedAt: new Date() });

  const deadline = Date.now() + REMOTE_REQUEST_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, REMOTE_POLL_MS));
    const fresh = await Device.findById(device._id).select('remoteAppium');
    if (fresh?.remoteAppium) {
      const { host, port } = fresh.remoteAppium;
      return { host, port, baseUrl: `http://${host}:${port}` };
    }
  }

  throw new AppiumUnavailableError(
    `No agent reported an Appium endpoint for device ${device.udid} (machine ${device.machineId}) within ` +
      `${REMOTE_REQUEST_TIMEOUT_MS / 1000}s. Check that an agent is running and polling for that machineId, ` +
      `and that it can reach \`appium\` on its own PATH.`,
  );
}

/**
 * Devices on this machine the hub is waiting on an agent-hosted Appium
 * endpoint for — carried on the agent's heartbeat response, the same
 * never-pushed-into shape `pendingInstalls`/`pendingUninstalls` already use.
 * Only devices actually missing a fresh endpoint are included, so a request
 * the agent already satisfied on a previous poll naturally drops off without
 * either side needing to track acknowledgement explicitly.
 */
export async function getPendingAppiumRequestsForMachine(
  machineId: string,
): Promise<{ deviceUdid: string; platform: 'android' | 'ios' }[]> {
  const devices = await Device.find({
    machineId,
    remoteAppiumRequestedAt: { $ne: null },
    remoteAppium: null,
  }).select('udid platform');
  return devices.map((d) => ({ deviceUdid: d.udid, platform: d.platform }));
}

/**
 * Records the endpoint an agent reports after starting (or adopting) its own
 * Appium server for one of its devices — the other half of the heartbeat
 * relay `ensureRemoteAppiumServer` waits on. Clears the request marker in the
 * same update so `getPendingAppiumRequestsForMachine` stops offering it.
 */
export async function reportRemoteAppiumReady(deviceUdid: string, machineId: string, host: string, port: number): Promise<void> {
  await Device.findOneAndUpdate(
    { udid: deviceUdid, machineId },
    { remoteAppium: { host, port, readyAt: new Date() }, remoteAppiumRequestedAt: null },
  );
}

/**
 * Closes any WebDriver session left open on this device's Appium server,
 * without restarting the server itself.
 *
 * A cancelled or orphaned run releases the device lock, but the runner it
 * killed may have left a session open inside a server that is deliberately
 * long-lived (one per device, reused across many runs — see the module doc
 * comment). Most mobile drivers only serve one session at a time, so a
 * lingering session would make the *next* run's session-creation fail against
 * a server that looks perfectly healthy, for a reason nothing on screen
 * explains. Restarting the server would also fix this, but throws away the
 * whole reason a persistent server exists (skipping Appium's own startup
 * cost); asking it what session it's holding and deleting just that is the
 * surgical version.
 *
 * A no-op, not an error, when no server is running for this device — there is
 * nothing to clean up, and a run that never got as far as starting Appium is
 * the common case for an early cancel.
 */
export async function closeActiveSessions(device: IDevice, config: EffectiveConfig): Promise<void> {
  if (!device.appiumPort) return;

  const endpoint: AppiumEndpoint = {
    host: config.appium.host,
    port: device.appiumPort,
    baseUrl: `http://${config.appium.host}:${device.appiumPort}`,
  };
  const prefix = await resolveAppiumPrefix(endpoint.baseUrl);
  if (prefix === null) return;

  try {
    const res = await fetch(`${endpoint.baseUrl}${prefix}/sessions`, { signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) });
    if (!res.ok) return;
    const body = (await res.json()) as { value?: Array<{ id?: string; sessionId?: string }> } | Array<{ id?: string }>;
    const sessions = Array.isArray(body) ? body : (body.value ?? []);
    for (const session of sessions) {
      const id = session.id ?? (session as { sessionId?: string }).sessionId;
      if (!id) continue;
      // Same prefix as the GET above — a session opened under /wd/hub only
      // closes at /wd/hub/session/:id, not the bare path.
      await fetch(`${endpoint.baseUrl}${prefix}/session/${id}`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
      }).catch(() => undefined); // best-effort — a session that won't close cleanly must not block lock release
    }
  } catch {
    // Best-effort cleanup: the device lock still releases either way, and the
    // next run's own session-creation will surface a real error if this
    // server genuinely can't take a new session.
  }
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
