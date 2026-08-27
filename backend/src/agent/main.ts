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
    hub: new HubClient(env.HUB_URL, env.AGENT_CREDENTIAL_TOKEN ?? env.AGENT_TOKEN),
  });

  const shutdown = (signal: string) => {
    console.log(`${signal} received — stopping agent`);
    agent.stop();
    process.exit(0);
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
