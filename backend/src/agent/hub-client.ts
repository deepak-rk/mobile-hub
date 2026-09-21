import * as fs from 'fs';
import { pipeline } from 'stream/promises';
import { Readable, Transform } from 'stream';
import { DiscoveredDevice } from './device-discovery';

export interface HostCapabilities {
  maxDevices: number;
  androidSupport: boolean;
  iosSupport: boolean;
}

export interface HostDiagnostics {
  diskFreeBytes: number | null;
  diskTotalBytes: number | null;
  nodeVersion: string | null;
}

export interface PendingInstall {
  installRunId: string;
  deviceUdid: string;
  buildId: string;
  platform: 'android' | 'ios';
  sizeBytes: number | null;
  /** The build's original source, straight off the hub's `Build.artifactUrl` — see installer.ts's use of it. */
  artifactUrl: string | null;
  /**
   * Org-wide `devices.grantPermissionsOnInstall` toggle, carried per target
   * since the agent has no access to org config itself — only what the hub
   * tells it. Android only; see installer.ts's `grantRuntimePermissions`.
   */
  grantPermissions: boolean;
}

export interface PendingUninstall {
  uninstallRunId: string;
  deviceUdid: string;
  packageName: string;
}

/** A device on this machine the hub is waiting on an Appium endpoint for — see appium-runner.ts. */
export interface PendingAppiumRequest {
  deviceUdid: string;
  platform: 'android' | 'ios';
}

export type InstallTargetStatus =
  | 'queued'
  | 'downloading'
  | 'transferring'
  | 'installing'
  | 'granting-permissions'
  | 'done'
  | 'error';
export type UninstallTargetStatus = 'queued' | 'uninstalling' | 'done' | 'error';

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

/**
 * Streams a fetch response's body to `destPath`, counting bytes for progress
 * and gating on integrity before the file is considered real — shared by
 * `downloadArtifact` (via the hub) and `downloadArtifactDirect` (straight from
 * a build's origin), so both reject a truncated or empty transfer identically.
 *
 * Writes to `<destPath>.part` and only renames it to `destPath` once the byte
 * count written matches `Content-Length` (when the server sent one) — without
 * this, a connection that closes early but doesn't error the stream (a
 * truncating intermediary, say) would leave a partial file at the real
 * destination, indistinguishable from a complete one to anything reading
 * `destPath` afterwards — the caller (`installer.ts`) goes on to push
 * whatever it finds straight to a device.
 */
async function streamToFileWithIntegrityGate(
  res: Response,
  destPath: string,
  errorLabel: string,
  onProgress?: (downloadedBytes: number, totalBytes: number | null) => void,
): Promise<void> {
  if (!res.body) throw new HubError(res.status, errorLabel, 'Response had no body.');

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

  const partPath = `${destPath}.part`;
  try {
    await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(partPath));

    if (downloadedBytes === 0) {
      throw new HubError(res.status, errorLabel, 'Download produced an empty file.');
    }
    if (Number.isFinite(totalBytes) && downloadedBytes !== totalBytes) {
      throw new HubError(
        res.status,
        errorLabel,
        `Download truncated: expected ${totalBytes as number} bytes, got ${downloadedBytes}.`,
      );
    }

    await fs.promises.rename(partPath, destPath);
  } catch (err) {
    await fs.promises.unlink(partPath).catch(() => undefined);
    throw err;
  }
}

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
    diagnostics?: HostDiagnostics;
  }): Promise<{
    pendingInstalls: PendingInstall[];
    pendingUninstalls: PendingUninstall[];
    pendingAppiumRequests: PendingAppiumRequest[];
  }> {
    // The response body used to be ignored entirely — reading pendingInstalls
    // (and, as of these fields, pendingUninstalls/pendingAppiumRequests) off
    // it is additive, not a breaking change to this call's contract.
    return this.post<{
      pendingInstalls: PendingInstall[];
      pendingUninstalls: PendingUninstall[];
      pendingAppiumRequests: PendingAppiumRequest[];
    }>('/api/hosts/heartbeat', params);
  }

  /**
   * Reports that this agent's own Appium server for `deviceUdid` is up and
   * answering at `host:port` — the reply to a `PendingAppiumRequest` seen on
   * a previous heartbeat. `machineId` travels as a query param (matching how
   * `requireAgentToken`'s scoping check reads it hub-side) since the body is
   * just the endpoint being reported, not this agent's own identity.
   */
  async reportAppiumReady(machineId: string, deviceUdid: string, host: string, port: number): Promise<void> {
    await this.post(`/api/hosts/appium-ready?machineId=${encodeURIComponent(machineId)}`, { deviceUdid, host, port });
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
   *
   * The integrity gate (`.part` staging, atomic rename, size validation) is
   * shared with `downloadArtifactDirect` below via `streamToFileWithIntegrityGate`
   * — both paths must reject a truncated/empty transfer the same way.
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
    await streamToFileWithIntegrityGate(res, destPath, path, onProgress);
  }

  /**
   * Fetches a build directly from its original source — bypassing the hub as
   * a byte proxy entirely — for whichever devices are attached to this agent.
   *
   * This is the "federated" half of build distribution: a hub proxying every
   * artifact byte to every agent becomes a bandwidth bottleneck (and a single
   * point of failure for a large transfer) the moment more than a couple of
   * agents exist. Callers (`installer.ts`) treat this as an optimization, not
   * a guarantee — a build only reachable through the hub (a `file://` source,
   * or an origin this agent's own network can't reach) must still work via
   * `downloadArtifact` above; this method throws like any other failed fetch
   * rather than silently falling back itself, since the caller is what knows
   * whether a fallback is appropriate.
   *
   * No `Authorization` header: the origin is an external source (whatever the
   * configured `BuildProvider` fetched from), not this hub, and has its own
   * auth story if it needs one — not this agent's shared/per-agent token.
   */
  async downloadArtifactDirect(
    originUrl: string,
    destPath: string,
    onProgress?: (downloadedBytes: number, totalBytes: number | null) => void,
  ): Promise<void> {
    const res = await fetch(originUrl, { signal: AbortSignal.timeout(ARTIFACT_DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new HubError(res.status, originUrl, text || res.statusText);
    }
    await streamToFileWithIntegrityGate(res, destPath, originUrl, onProgress);
  }

  async reportInstallProgress(
    installRunId: string,
    deviceUdid: string,
    update: { status: InstallTargetStatus; progress?: number; error?: string; packageName?: string },
  ): Promise<void> {
    await this.post(`/api/device-installs/${installRunId}/targets/${deviceUdid}/report`, update);
  }

  async reportUninstallProgress(
    uninstallRunId: string,
    deviceUdid: string,
    update: { status: UninstallTargetStatus; error?: string },
  ): Promise<void> {
    await this.post(`/api/device-installs/uninstalls/${uninstallRunId}/targets/${deviceUdid}/report`, update);
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
