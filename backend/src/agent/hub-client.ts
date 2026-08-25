import { DiscoveredDevice } from './device-discovery';

export interface HostCapabilities {
  maxDevices: number;
  androidSupport: boolean;
  iosSupport: boolean;
}

export class HubError extends Error {
  constructor(
    public readonly status: number,
    public readonly endpoint: string,
    message: string,
  ) {
    super(`${endpoint} failed (${status}): ${message}`);
    this.name = 'HubError';
  }
}

const REQUEST_TIMEOUT_MS = 10_000;

/** Thin wrapper over the two endpoints an agent talks to. */
export class HubClient {
  constructor(private readonly baseUrl: string) {}

  async heartbeat(params: {
    machineId: string;
    hostname: string;
    os: 'darwin' | 'linux' | 'win32';
    agentVersion: string;
    capabilities: HostCapabilities;
  }): Promise<void> {
    await this.post('/api/hosts/heartbeat', params);
  }

  async syncDevices(machineId: string, devices: DiscoveredDevice[]): Promise<{ upserted: number; markedOffline: number }> {
    return this.post<{ upserted: number; markedOffline: number }>('/api/devices/sync', { machineId, devices });
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new HubError(res.status, path, text || res.statusText);
    }
    return (await res.json()) as T;
  }
}
