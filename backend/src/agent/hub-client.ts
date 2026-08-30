import * as fs from 'fs';
import { pipeline } from 'stream/promises';
import { Readable, Transform } from 'stream';
import { DiscoveredDevice } from './device-discovery';

export interface HostCapabilities {
  maxDevices: number;
  androidSupport: boolean;
  iosSupport: boolean;
}

export interface PendingInstall {
  installRunId: string;
  deviceUdid: string;
  buildId: string;
  platform: 'android' | 'ios';
  sizeBytes: number | null;
}

export type InstallTargetStatus = 'queued' | 'downloading' | 'transferring' | 'installing' | 'done' | 'error';

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
// Build artifacts run to hundreds of MB — the plain request timeout above
// would kill a real download partway through.
const ARTIFACT_DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

/** Thin wrapper over the two endpoints an agent talks to. */
export class HubClient {
  /**
   * A per-agent credential's raw token, or the hub's shared AGENT_TOKEN as a
   * fallback — either is sent the same way (a Bearer header), so this class
   * doesn't need to know which. Omit only against a dev hub with no auth
   * configured at all.
   */
  constructor(
    private readonly baseUrl: string,
    private readonly agentToken?: string,
  ) {}

  async heartbeat(params: {
    machineId: string;
    hostname: string;
    os: 'darwin' | 'linux' | 'win32';
    agentVersion: string;
    capabilities: HostCapabilities;
  }): Promise<{ pendingInstalls: PendingInstall[] }> {
    // The response body used to be ignored entirely — reading pendingInstalls
    // off it is additive, not a breaking change to this call's contract.
    return this.post<{ pendingInstalls: PendingInstall[] }>('/api/hosts/heartbeat', params);
  }

  async syncDevices(machineId: string, devices: DiscoveredDevice[]): Promise<{ upserted: number; markedOffline: number }> {
    return this.post<{ upserted: number; markedOffline: number }>('/api/devices/sync', { machineId, devices });
  }

  /**
   * Streams a build artifact's bytes down to `destPath`, reporting real
   * transfer progress as it goes.
   *
   * Previously this piped the response straight to disk with no counting, so
   * the only values `InstallTarget.progress` ever carried were 0 and 100 —
   * while the UI rendered a *determinate* progress bar from it. A determinate
   * bar fed by two values is a lie on screen, and it is the one users
   * reported. `onProgress` is throttled by the caller, not here.
   *
   * `totalBytes` is null when the server sends no `Content-Length`; callers
   * must then show indeterminate progress rather than inventing a percentage.
   */
  async downloadArtifact(
    buildId: string,
    destPath: string,
    onProgress?: (downloadedBytes: number, totalBytes: number | null) => void,
  ): Promise<void> {
    const path = `/api/builds/${buildId}/artifact`;
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: this.agentToken ? { Authorization: `Bearer ${this.agentToken}` } : {},
      signal: AbortSignal.timeout(ARTIFACT_DOWNLOAD_TIMEOUT_MS),
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new HubError(res.status, path, text || res.statusText);
    }

    const header = res.headers.get('content-length');
    const totalBytes = header ? Number(header) : null;
    let downloadedBytes = 0;

    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        downloadedBytes += chunk.length;
        onProgress?.(downloadedBytes, Number.isFinite(totalBytes) ? totalBytes : null);
        callback(null, chunk);
      },
    });

    await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(destPath));
  }

  async reportInstallProgress(
    installRunId: string,
    deviceUdid: string,
    update: { status: InstallTargetStatus; progress?: number; error?: string },
  ): Promise<void> {
    await this.post(`/api/device-installs/${installRunId}/targets/${deviceUdid}/report`, update);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.agentToken ? { Authorization: `Bearer ${this.agentToken}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (res.status === 401) {
        throw new HubError(
          401,
          path,
          'the hub rejected this agent token. Set AGENT_TOKEN on this agent to match the hub.',
        );
      }
      throw new HubError(res.status, path, text || res.statusText);
    }
    return (await res.json()) as T;
  }
}
