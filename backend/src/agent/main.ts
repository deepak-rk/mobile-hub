import * as os from 'os';
import { z } from 'zod';
import * as dotenv from 'dotenv';
import { DeviceAgent } from './agent';
import { HubClient } from './hub-client';
import { getDeviceDiscovery } from './sources/get-discovery';

dotenv.config();

/**
 * The agent runs on each host machine in the lab, not on the hub. It is
 * configured entirely separately from the server (its own env vars, its own
 * entry point) because in a real deployment it runs on a different box.
 */
const envSchema = z.object({
  HUB_URL: z.string().url().default('http://localhost:3000'),
  // Stable per host: it is the key every device, run and stream is filed
  // under, so a machine that changes it orphans all of its own records.
  MACHINE_ID: z.string().min(1).default(os.hostname()),
  AGENT_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(10_000),
  AGENT_MAX_DEVICES: z.coerce.number().int().nonnegative().default(8),
  AGENT_DISCOVERY: z.string().optional(),
  // Only used when the hub's `appium.remoteEnabled` is on (default off) —
  // see appium-runner.ts. AGENT_APPIUM_HOST must be an address the *hub* can
  // actually reach; 127.0.0.1 only makes sense when the hub and this agent
  // are known to share a network namespace (e.g. one dev box), which is why
  // it stays the default rather than something that looks production-ready
  // but silently isn't for a genuinely separate machine.
  AGENT_APPIUM_HOST: z.string().default('127.0.0.1'),
  // Distinct from the hub's own default appium.basePort (4723) so the two
  // can coexist on one machine without colliding — the shape this repo's own
  // synthetic-second-agent validation relies on.
  AGENT_APPIUM_BASE_PORT: z.coerce.number().int().positive().default(4823),
  // Preferred: a per-agent credential minted via POST /api/agent-credentials
  // (admin-only), scoped to this host's machineId and individually
  // revocable. Takes priority over AGENT_TOKEN below when both are set.
  AGENT_CREDENTIAL_TOKEN: z.string().optional(),
  // Legacy fallback: the hub's single shared secret. Must match the hub's
  // AGENT_TOKEN. Optional only against a dev hub that has none.
  AGENT_TOKEN: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('❌ Invalid agent environment:\n', parsed.error.flatten().fieldErrors);
  process.exit(1);
}
const env = parsed.data;

function hostOs(): 'darwin' | 'linux' | 'win32' {
  const p = process.platform;
  if (p === 'darwin' || p === 'linux' || p === 'win32') return p;
  // The hub's schema only knows these three; refuse rather than send junk.
  console.error(`❌ Unsupported platform '${p}' — the hub accepts darwin, linux or win32.`);
  process.exit(1);
}

async function main(): Promise<void> {
  const discovery = getDeviceDiscovery(env.AGENT_DISCOVERY);

  const agent = new DeviceAgent({
    machineId: env.MACHINE_ID,
    hostname: os.hostname(),
    os: hostOs(),
    agentVersion: process.env.npm_package_version ?? '0.1.0',
    capabilities: {
      maxDevices: env.AGENT_MAX_DEVICES,
      // adb-based discovery is Android-only; iOS needs an adapter that
      // doesn't exist yet, so claiming support would be a lie the hub acts on.
      androidSupport: true,
      iosSupport: false,
    },
    pollIntervalMs: env.AGENT_POLL_INTERVAL_MS,
    discovery,
    hub: new HubClient(env.HUB_URL, env.AGENT_CREDENTIAL_TOKEN ?? env.AGENT_TOKEN, env.MACHINE_ID),
    appiumHost: env.AGENT_APPIUM_HOST,
    appiumBasePort: env.AGENT_APPIUM_BASE_PORT,
  });

  const shutdown = (signal: string) => {
    console.log(`${signal} received — stopping agent`);
    // Awaited before exiting: `stop()` now kills this agent's Appium servers,
    // and exiting first would orphan the very processes it is there to reap.
    // Failure still exits — a stuck teardown must not wedge the signal.
    agent
      .stop()
      .catch((err: unknown) => {
        console.error(`error during shutdown: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  try {
    await agent.start();
  } catch (err) {
    console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

void main();
