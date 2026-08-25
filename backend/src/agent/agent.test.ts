import { describe, it, expect, vi } from 'vitest';
import { DeviceAgent } from './agent';
import { SyntheticDeviceDiscovery } from './sources/synthetic-discovery';
import type { HubClient } from './hub-client';
import type { DeviceDiscovery } from './device-discovery';

function fakeHub(overrides: Partial<HubClient> = {}) {
  return {
    heartbeat: vi.fn().mockResolvedValue(undefined),
    syncDevices: vi.fn().mockResolvedValue({ upserted: 0, markedOffline: 0 }),
    ...overrides,
  } as unknown as HubClient & { heartbeat: ReturnType<typeof vi.fn>; syncDevices: ReturnType<typeof vi.fn> };
}

function makeAgent(discovery: DeviceDiscovery, hub: ReturnType<typeof fakeHub>) {
  return new DeviceAgent({
    machineId: 'host-1',
    hostname: 'host-1',
    os: 'linux',
    agentVersion: '0.1.0',
    capabilities: { maxDevices: 4, androidSupport: true, iosSupport: false },
    pollIntervalMs: 10_000,
    discovery,
    hub,
    log: () => {}, // keep test output clean
  });
}

describe('DeviceAgent.tick', () => {
  it('reports discovered devices to the hub', async () => {
    const hub = fakeHub();
    const agent = makeAgent(new SyntheticDeviceDiscovery(), hub);

    const result = await agent.tick();

    expect(result.devices).toHaveLength(3);
    expect(hub.syncDevices).toHaveBeenCalledWith('host-1', result.devices);
  });

  it('heartbeats even when the host has no devices attached', async () => {
    // An empty lab must still show the host as online — otherwise it is
    // indistinguishable from a dead agent.
    const hub = fakeHub();
    const agent = makeAgent(new SyntheticDeviceDiscovery([]), hub);

    const result = await agent.tick();

    expect(result.devices).toEqual([]);
    expect(hub.heartbeat).toHaveBeenCalledOnce();
    expect(hub.syncDevices).toHaveBeenCalledWith('host-1', []);
  });

  it('sends the host identity and capabilities with every heartbeat', async () => {
    const hub = fakeHub();
    await makeAgent(new SyntheticDeviceDiscovery(), hub).tick();

    expect(hub.heartbeat).toHaveBeenCalledWith({
      machineId: 'host-1',
      hostname: 'host-1',
      os: 'linux',
      agentVersion: '0.1.0',
      capabilities: { maxDevices: 4, androidSupport: true, iosSupport: false },
    });
  });

  it('surfaces a hub failure to the caller rather than swallowing it', async () => {
    const hub = fakeHub({ syncDevices: vi.fn().mockRejectedValue(new Error('hub down')) as never });
    await expect(makeAgent(new SyntheticDeviceDiscovery(), hub).tick()).rejects.toThrow('hub down');
  });
});

describe('DeviceAgent.start', () => {
  it('refuses to start when discovery is unavailable, with a fixable message', async () => {
    // A silent no-op agent is worse than a loud failure: the lab would just
    // appear empty with nothing explaining why.
    const unavailable: DeviceDiscovery = {
      name: 'adb',
      isAvailable: () => Promise.resolve(false),
      discover: () => Promise.resolve([]),
    };
    const agent = makeAgent(unavailable, fakeHub());

    await expect(agent.start()).rejects.toThrow(/not available on this host/);
    await expect(agent.start()).rejects.toThrow(/AGENT_DISCOVERY=synthetic/);
  });

  it('keeps polling after a failed tick instead of dying', async () => {
    // A hub restart or brief network blip must not require someone to walk
    // over to the host machine and restart the agent.
    const hub = fakeHub({
      syncDevices: vi
        .fn()
        .mockRejectedValueOnce(new Error('hub down'))
        .mockResolvedValue({ upserted: 3, markedOffline: 0 }) as never,
    });
    const agent = new DeviceAgent({
      machineId: 'host-1',
      hostname: 'host-1',
      os: 'linux',
      agentVersion: '0.1.0',
      capabilities: { maxDevices: 4, androidSupport: true, iosSupport: false },
      pollIntervalMs: 5,
      discovery: new SyntheticDeviceDiscovery(),
      hub,
      log: () => {},
    });

    await agent.start();
    await new Promise((r) => setTimeout(r, 60));
    agent.stop();

    expect(hub.syncDevices.mock.calls.length).toBeGreaterThan(1);
  });
});
