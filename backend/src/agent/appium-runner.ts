import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as supervisor from '../common/process-supervisor';
import { ManagedProcess } from '../common/process-supervisor';
import { buildRunEnvironment } from '../modules/execution/run-environment';

/**
 * See `appium.service.ts`'s identical helper for why this writes a temp file
 * instead of passing JSON inline: on Windows, `appium` resolves to a `.cmd`
 * shim which must be spawned via `shell: true`, and cmd.exe's own argument
 * re-quoting strips the double quotes out of an inline JSON string.
 */
function writeDefaultCapabilitiesFile(udid: string): string {
  const file = path.join(os.tmpdir(), `mh-agent-appium-caps-${udid.replace(/[^a-zA-Z0-9-]/g, '_')}.json`);
  fs.writeFileSync(file, JSON.stringify({ 'appium:udid': udid }));
  return file;
}

/**
 * Runs Appium locally, on the agent, for this agent's own devices — the
 * counterpart to `modules/execution/appium.service.ts`'s hub-local path.
 *
 * Ported from that file's `ensureAppiumServer`/`startServer`/`isServerUp`:
 * same adopt-don't-replace behavior, same EADDRINUSE-vs-genuine-failure
 * distinction, same retry-on-contention loop. Not a shared import, because
 * that file is Mongoose-coupled (device/port persistence lives in Mongo) and
 * the agent process never connects to a database — this module's port
 * bookkeeping is in-memory instead, which is the right scope for it: an
 * agent only ever manages its own small set of devices, not a fleet-wide
 * registry the way the hub does, so nothing here needs to survive a restart
 * (a restarted agent just gets fresh ports; the hub's own health-check in
 * `ensureRemoteAppiumServer` already treats a stale reported endpoint as
 * untrustworthy rather than assuming it's still alive).
 */

export interface AppiumEndpoint {
  host: string;
  port: number;
  baseUrl: string;
}

export class AppiumUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppiumUnavailableError';
  }
}

const STATUS_TIMEOUT_MS = 2000;
const STARTUP_TIMEOUT_MS = 60_000;
const STARTUP_POLL_MS = 500;
const PORT_CONTENTION_TIMEOUT_MS = 45_000;
const PORT_RETRY_DELAY_MS = 2000;

const REQUIRED_DRIVER: Record<string, string> = { android: 'uiautomator2', ios: 'xcuitest' };

/** Live servers this agent started, keyed by udid — one agent, one machine, no cross-host collision to guard against. */
const servers = new Map<string, ManagedProcess>();
/** Port assigned to each device so far this process's lifetime. */
const devicePorts = new Map<string, number>();
const usedPorts = new Set<number>();

function allocatePort(udid: string, basePort: number): number {
  const existing = devicePorts.get(udid);
  if (existing) return existing;
  let port = basePort;
  while (usedPorts.has(port)) port += 1;
  devicePorts.set(udid, port);
  usedPorts.add(port);
  return port;
}

async function isServerUp(endpoint: AppiumEndpoint): Promise<boolean> {
  try {
    const res = await fetch(`${endpoint.baseUrl}/status`, { signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Same parity requirement as the hub-local path: a run must fail fast and clearly, not two minutes in against a missing driver. */
export async function assertDriverInstalled(platform: string): Promise<void> {
  const driver = REQUIRED_DRIVER[platform];
  if (!driver) return;

  let output = '';
  const collect = (chunk: Buffer): void => {
    output += chunk.toString();
  };
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
      `Appium has no '${driver}' driver installed on this agent, which ${platform} sessions require. ` +
        `Install it with \`appium driver install ${driver}\`.`,
    );
  }
}

type StartOutcome = { kind: 'started' } | { kind: 'port-busy' } | { kind: 'failed'; exited: boolean; detail: string };

async function startServer(udid: string, endpoint: AppiumEndpoint): Promise<StartOutcome> {
  servers.delete(udid);

  let startupOutput = '';
  const collect = (chunk: Buffer): void => {
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
      '--default-capabilities',
      writeDefaultCapabilitiesFile(udid),
    ],
    cwd: process.cwd(),
    env: buildRunEnvironment({ configured: {} }),
    onStdout: collect,
    onStderr: collect,
  });
  servers.set(udid, managed);

  let exited = false;
  void managed.result.then(() => {
    exited = true;
    servers.delete(udid);
  });

  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited) break;
    await new Promise((r) => setTimeout(r, STARTUP_POLL_MS));
    if (await isServerUp(endpoint)) return { kind: 'started' };
  }

  managed.cancel();
  servers.delete(udid);
  const detail = startupOutput.trim();
  if (detail.includes('EADDRINUSE')) return { kind: 'port-busy' };
  return { kind: 'failed', exited, detail };
}

/**
 * Ensures this agent has an Appium server running for `udid`, starting or
 * adopting one as needed, and returns its endpoint for the hub to relay to a
 * run. `host` should be an address the *hub* can actually reach — not
 * `127.0.0.1` unless the hub and this agent are known to share a network
 * namespace (e.g. the same box in dev) — callers choose it, this function
 * only binds Appium to it.
 */
export async function ensureLocalAppiumServer(
  udid: string,
  opts: { host: string; basePort: number },
): Promise<AppiumEndpoint> {
  const port = allocatePort(udid, opts.basePort);
  const endpoint: AppiumEndpoint = { host: opts.host, port, baseUrl: `http://${opts.host}:${port}` };

  const contendedUntil = Date.now() + PORT_CONTENTION_TIMEOUT_MS;
  for (;;) {
    if (await isServerUp(endpoint)) return endpoint;

    const outcome = await startServer(udid, endpoint);
    if (outcome.kind === 'started') return endpoint;

    if (outcome.kind === 'port-busy') {
      if (Date.now() < contendedUntil) {
        await new Promise((r) => setTimeout(r, PORT_RETRY_DELAY_MS));
        continue;
      }
      throw new AppiumUnavailableError(
        `Port ${port} stayed busy for ${PORT_CONTENTION_TIMEOUT_MS / 1000}s without ever answering as Appium.`,
      );
    }

    throw new AppiumUnavailableError(
      (outcome.exited
        ? `Appium exited during startup on ${endpoint.baseUrl}.`
        : `Appium did not become ready on ${endpoint.baseUrl} within ${STARTUP_TIMEOUT_MS / 1000}s.`) +
        (outcome.detail ? `\nAppium said:\n${outcome.detail}` : '\nAppium produced no output before failing.'),
    );
  }
}

/** Stops every server this agent started — called on agent shutdown so nothing outlives the process that owns it. */
export async function shutdownLocalAppiumServers(): Promise<void> {
  const running = [...servers.values()];
  servers.clear();
  for (const managed of running) managed.cancel();
  await Promise.all(running.map((m) => m.result));
}
