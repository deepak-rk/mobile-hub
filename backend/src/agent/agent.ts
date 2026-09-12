import { DeviceDiscovery, DiscoveredDevice } from './device-discovery';
import { HubClient, HostCapabilities, PendingInstall, PendingUninstall } from './hub-client';
import { runInstall } from './installer';
import { runUninstall } from './uninstaller';

export interface AgentOptions {
  machineId: string;
  hostname: string;
  os: 'darwin' | 'linux' | 'win32';
  agentVersion: string;
  capabilities: HostCapabilities;
  pollIntervalMs: number;
  discovery: DeviceDiscovery;
  hub: HubClient;
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

export interface TickResult {
  devices: DiscoveredDevice[];
  upserted: number;
  markedOffline: number;
}

/**
 * The host-side loop: discover what's attached, tell the hub, repeat.
 *
 * Deliberately dumb and stateless — the hub owns all reconciliation
 * (`syncDevices` marks anything no longer reported as offline and releases
 * its locks). The agent's only job is to report the truth about this host,
 * so an agent restart or a missed poll self-heals on the next tick.
 */
export class DeviceAgent {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private consecutiveFailures = 0;
  // Keyed by `${installRunId}:${deviceUdid}` — the same pending target can
  // reappear on consecutive heartbeat responses until the hub sees a
  // non-'queued' report for it, so this guards against starting it twice
  // while the first attempt is still in flight.
  private readonly inFlightInstalls = new Set<string>();
  // Same guard, same reason, for uninstalls — a distinct set because the two
  // key spaces (`installRunId:udid` vs `uninstallRunId:udid`) are otherwise
  // indistinguishable and a collision would silently drop a real re-poll.
  private readonly inFlightUninstalls = new Set<string>();

  constructor(private readonly opts: AgentOptions) {}

  private log(level: 'info' | 'warn' | 'error', msg: string): void {
    (this.opts.log ?? ((l, m) => console[l === 'info' ? 'log' : l](m)))(level, msg);
  }

  /** One discover-and-report cycle. Exposed so it can be driven directly in tests. */
  async tick(): Promise<TickResult> {
    const devices = await this.opts.discovery.discover();

    // Heartbeat first: a host with zero devices must still show as online,
    // otherwise an empty lab looks like a dead agent.
    const { pendingInstalls, pendingUninstalls } = await this.opts.hub.heartbeat({
      machineId: this.opts.machineId,
      hostname: this.opts.hostname,
      os: this.opts.os,
      agentVersion: this.opts.agentVersion,
      capabilities: this.opts.capabilities,
    });
    this.startPendingInstalls(pendingInstalls);
    this.startPendingUninstalls(pendingUninstalls);

    const { upserted, markedOffline } = await this.opts.hub.syncDevices(this.opts.machineId, devices);
    return { devices, upserted, markedOffline };
  }

  /**
   * Kicks off any newly-seen pending installs in the background — NOT
   * awaited, so a large APK download can't stall the next discover/heartbeat
   * cycle (which must keep running regardless of how long an install takes).
   */
  private startPendingInstalls(pendingInstalls: PendingInstall[]): void {
    for (const pending of pendingInstalls) {
      const key = `${pending.installRunId}:${pending.deviceUdid}`;
      if (this.inFlightInstalls.has(key)) continue;
      this.inFlightInstalls.add(key);

      void runInstall(this.opts.hub, pending)
        .catch((err: unknown) => {
          this.log('error', `install ${key} failed: ${err instanceof Error ? err.message : String(err)}`);
        })
        .finally(() => this.inFlightInstalls.delete(key));
    }
  }

  /** Same not-awaited, in-flight-guarded shape as startPendingInstalls. */
  private startPendingUninstalls(pendingUninstalls: PendingUninstall[]): void {
    for (const pending of pendingUninstalls) {
      const key = `${pending.uninstallRunId}:${pending.deviceUdid}`;
      if (this.inFlightUninstalls.has(key)) continue;
      this.inFlightUninstalls.add(key);

      void runUninstall(this.opts.hub, pending)
        .catch((err: unknown) => {
          this.log('error', `uninstall ${key} failed: ${err instanceof Error ? err.message : String(err)}`);
        })
        .finally(() => this.inFlightUninstalls.delete(key));
    }
  }

  async start(): Promise<void> {
    if (this.running) return;

    if (!(await this.opts.discovery.isAvailable())) {
      throw new Error(
        `Device discovery '${this.opts.discovery.name}' is not available on this host. ` +
          `For adb, install platform-tools and ensure \`adb\` is on PATH or set ADB_PATH. ` +
          `To run without any devices attached, set AGENT_DISCOVERY=synthetic.`,
      );
    }

    this.running = true;
    this.log('info', `agent started: machineId=${this.opts.machineId} discovery=${this.opts.discovery.name}`);
    void this.loop();
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const { devices, markedOffline } = await this.tick();
        if (this.consecutiveFailures > 0) {
          this.log('info', `hub reachable again after ${this.consecutiveFailures} failed attempt(s)`);
          this.consecutiveFailures = 0;
        }
        this.log(
          'info',
          `reported ${devices.length} device(s)${markedOffline > 0 ? `, ${markedOffline} marked offline` : ''}`,
        );
      } catch (err) {
        this.consecutiveFailures += 1;
        const msg = err instanceof Error ? err.message : String(err);
        // Keep going: a hub restart or a brief network blip must not require
        // someone to walk over to the host machine and restart the agent.
        // Only the first failure and every tenth are logged, so an overnight
        // outage doesn't produce a gigabyte of identical lines.
        if (this.consecutiveFailures === 1 || this.consecutiveFailures % 10 === 0) {
          this.log('warn', `poll failed (${this.consecutiveFailures} in a row): ${msg}`);
        }
      }

      await new Promise((resolve) => {
        this.timer = setTimeout(resolve, this.opts.pollIntervalMs);
      });
    }
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.log('info', 'agent stopped');
  }
}
