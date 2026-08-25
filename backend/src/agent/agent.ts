import { DeviceDiscovery, DiscoveredDevice } from './device-discovery';
import { HubClient, HostCapabilities } from './hub-client';

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

  constructor(private readonly opts: AgentOptions) {}

  private log(level: 'info' | 'warn' | 'error', msg: string): void {
    (this.opts.log ?? ((l, m) => console[l === 'info' ? 'log' : l](m)))(level, msg);
  }

  /** One discover-and-report cycle. Exposed so it can be driven directly in tests. */
  async tick(): Promise<TickResult> {
    const devices = await this.opts.discovery.discover();

    // Heartbeat first: a host with zero devices must still show as online,
    // otherwise an empty lab looks like a dead agent.
    await this.opts.hub.heartbeat({
      machineId: this.opts.machineId,
      hostname: this.opts.hostname,
      os: this.opts.os,
      agentVersion: this.opts.agentVersion,
      capabilities: this.opts.capabilities,
    });

    const { upserted, markedOffline } = await this.opts.hub.syncDevices(this.opts.machineId, devices);
    return { devices, upserted, markedOffline };
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
