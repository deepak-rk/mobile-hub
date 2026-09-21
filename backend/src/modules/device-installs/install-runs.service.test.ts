import { describe, it, expect, vi, afterEach } from 'vitest';
import { InstallRun } from './install-run.model';
import { UninstallRun } from './uninstall-run.model';
import { Build } from '../builds/build.model';
import * as buildsService from '../builds/builds.service';
import * as devicesService from '../devices/devices.service';
import {
  BuildNotReadyError,
  IncompatibleDeviceError,
  UnknownDeviceError,
  triggerInstallRun,
  getPendingInstallsForMachine,
  getActiveInstallCountForMachine,
  reportTargetProgress,
  getInstalledDevicesForBuild,
} from './install-runs.service';

afterEach(() => {
  vi.restoreAllMocks();
});

const readyBuild = {
  _id: 'build-1',
  id: 'build-1',
  project: 'demo-app',
  platform: 'android' as const,
  status: 'ready' as const,
};

describe('triggerInstallRun', () => {
  it('rejects a build that is not ready', async () => {
    vi.spyOn(buildsService, 'getBuild').mockResolvedValue({ ...readyBuild, status: 'downloading' } as never);

    await expect(triggerInstallRun({ buildId: 'build-1', deviceUdids: ['d1'], triggeredBy: 'user-1' })).rejects.toThrow(
      BuildNotReadyError,
    );
  });

  it('rejects a target device that does not exist', async () => {
    vi.spyOn(buildsService, 'getBuild').mockResolvedValue(readyBuild as never);
    vi.spyOn(devicesService, 'getDevice').mockResolvedValue(null);

    await expect(
      triggerInstallRun({ buildId: 'build-1', deviceUdids: ['ghost'], triggeredBy: 'user-1' }),
    ).rejects.toThrow(UnknownDeviceError);
  });

  it('rejects a device whose platform the artifact cannot run on', async () => {
    // The frontend already filters the picker by platform, but a filtered
    // picker is a convenience, never a guarantee — without this check an
    // Android APK aimed at an iOS device failed late and confusingly at the
    // agent instead of being refused up front.
    vi.spyOn(buildsService, 'getBuild').mockResolvedValue(readyBuild as never); // android
    vi.spyOn(devicesService, 'getDevice').mockResolvedValue({
      udid: 'iphone-1',
      machineId: 'host-1',
      platform: 'ios',
    } as never);

    await expect(
      triggerInstallRun({ buildId: 'build-1', deviceUdids: ['iphone-1'], triggeredBy: 'user-1' }),
    ).rejects.toThrow(IncompatibleDeviceError);
  });

  it('rejects the whole run if any one target is incompatible', async () => {
    vi.spyOn(buildsService, 'getBuild').mockResolvedValue(readyBuild as never);
    vi.spyOn(devicesService, 'getDevice').mockImplementation(
      async (udid) => ({ udid, machineId: 'host-1', platform: udid === 'bad' ? 'ios' : 'android' }) as never,
    );
    const create = vi.spyOn(InstallRun, 'create');

    await expect(
      triggerInstallRun({ buildId: 'build-1', deviceUdids: ['ok', 'bad'], triggeredBy: 'user-1' }),
    ).rejects.toThrow(IncompatibleDeviceError);
    // Nothing partially created — the caller fixes the selection and retries.
    expect(create).not.toHaveBeenCalled();
  });

  it('creates one queued target per device, with no lock acquired', async () => {
    vi.spyOn(buildsService, 'getBuild').mockResolvedValue(readyBuild as never);
    vi.spyOn(devicesService, 'getDevice').mockImplementation(
      async (udid) => ({ udid, machineId: 'host-1', platform: 'android' }) as never,
    );
    const acquireLock = vi.spyOn(devicesService, 'acquireLock');
    const create = vi.spyOn(InstallRun, 'create').mockResolvedValue({ targets: [] } as never);

    await triggerInstallRun({ buildId: 'build-1', deviceUdids: ['d1', 'd2'], triggeredBy: 'user-1' });

    const passedTargets = (create.mock.calls[0][0] as { targets: { deviceUdid: string; status: string }[] }).targets;
    expect(passedTargets).toHaveLength(2);
    expect(passedTargets.every((t) => t.status === 'queued')).toBe(true);
    // The deliberate no-locking decision (install-run.model.ts) — never call
    // acquireLock, unlike execution's triggerExecutionRun.
    expect(acquireLock).not.toHaveBeenCalled();
  });
});

describe('getPendingInstallsForMachine', () => {
  it('only returns targets for the requested machine that are still queued', async () => {
    vi.spyOn(InstallRun, 'find').mockResolvedValue([
      {
        id: 'run-1',
        buildId: { toString: () => 'build-1' },
        platform: 'android',
        targets: [
          { deviceUdid: 'd1', machineId: 'host-1', status: 'queued' },
          { deviceUdid: 'd2', machineId: 'host-1', status: 'done' }, // already finished
          { deviceUdid: 'd3', machineId: 'host-2', status: 'queued' }, // different host
        ],
      },
    ] as never);
    // The artifact size travels with the pending install so the agent always
    // has an honest denominator, even when the artifact response carries no
    // Content-Length (a proxy using chunked encoding drops it).
    vi.spyOn(Build, 'find').mockReturnValue({
      select: vi.fn().mockResolvedValue([{ id: 'build-1', sizeBytes: 4242, artifactUrl: 'https://example.com/app.apk' }]),
    } as never);

    const pending = await getPendingInstallsForMachine('host-1');

    expect(pending).toEqual([
      {
        installRunId: 'run-1',
        deviceUdid: 'd1',
        buildId: 'build-1',
        platform: 'android',
        sizeBytes: 4242,
        artifactUrl: 'https://example.com/app.apk',
        grantPermissions: false,
      },
    ]);
  });

  it('carries the org-wide grantPermissionsOnInstall toggle onto every pending target', async () => {
    vi.spyOn(InstallRun, 'find').mockResolvedValue([
      {
        id: 'run-1',
        buildId: { toString: () => 'build-1' },
        platform: 'android',
        targets: [{ deviceUdid: 'd1', machineId: 'host-1', status: 'queued' }],
      },
    ] as never);
    vi.spyOn(Build, 'find').mockReturnValue({
      select: vi.fn().mockResolvedValue([{ id: 'build-1', sizeBytes: 4242, artifactUrl: '' }]),
    } as never);

    const [pending] = await getPendingInstallsForMachine('host-1', true);

    expect(pending.grantPermissions).toBe(true);
  });

  it('sends a null artifactUrl when the build has none (e.g. a file:// source, or none reported)', async () => {
    vi.spyOn(InstallRun, 'find').mockResolvedValue([
      {
        id: 'run-1',
        buildId: { toString: () => 'build-1' },
        platform: 'android',
        targets: [{ deviceUdid: 'd1', machineId: 'host-1', status: 'queued' }],
      },
    ] as never);
    vi.spyOn(Build, 'find').mockReturnValue({
      select: vi.fn().mockResolvedValue([{ id: 'build-1', sizeBytes: 4242, artifactUrl: '' }]),
    } as never);

    const [pending] = await getPendingInstallsForMachine('host-1');

    expect(pending.artifactUrl).toBeNull();
  });

  it('sends a null size rather than guessing when the build record has none', async () => {
    vi.spyOn(InstallRun, 'find').mockResolvedValue([
      {
        id: 'run-1',
        buildId: { toString: () => 'build-1' },
        platform: 'android',
        targets: [{ deviceUdid: 'd1', machineId: 'host-1', status: 'queued' }],
      },
    ] as never);
    vi.spyOn(Build, 'find').mockReturnValue({
      select: vi.fn().mockResolvedValue([{ id: 'build-1', sizeBytes: null }]),
    } as never);

    const [pending] = await getPendingInstallsForMachine('host-1');

    // The agent must then show indeterminate progress, not a fabricated bar.
    expect(pending.sizeBytes).toBeNull();
  });
});

describe('getActiveInstallCountForMachine', () => {
  it('counts in-flight targets scoped to the requested machine', async () => {
    const countDocuments = vi.spyOn(InstallRun, 'countDocuments').mockResolvedValue(2 as never);

    const count = await getActiveInstallCountForMachine('host-1');

    expect(count).toBe(2);
    expect(countDocuments).toHaveBeenCalledWith({
      'targets.machineId': 'host-1',
      'targets.status': { $in: ['queued', 'downloading', 'transferring', 'installing', 'granting-permissions'] },
    });
  });
});

describe('reportTargetProgress', () => {
  function fakeRun() {
    const doc = {
      id: 'run-1',
      buildId: { toString: () => 'build-1' },
      targets: [{ deviceUdid: 'd1', machineId: 'host-1', status: 'queued', progress: 0, error: null, startedAt: null, endedAt: null }],
    };
    (doc as unknown as { save: () => Promise<void> }).save = vi.fn().mockResolvedValue(undefined);
    return doc;
  }

  it('mutates the matching target and stamps startedAt on the first non-queued report', async () => {
    const doc = fakeRun();
    vi.spyOn(InstallRun, 'findById').mockResolvedValue(doc as never);

    await reportTargetProgress('run-1', 'd1', { status: 'downloading', progress: 40 });

    const target = doc.targets[0];
    expect(target.status).toBe('downloading');
    expect(target.progress).toBe(40);
    expect(target.startedAt).toBeInstanceOf(Date);
    expect(target.endedAt).toBeNull();
  });

  it('stamps endedAt on a terminal status', async () => {
    const doc = fakeRun();
    vi.spyOn(InstallRun, 'findById').mockResolvedValue(doc as never);

    await reportTargetProgress('run-1', 'd1', { status: 'error', error: 'adb install failed' });

    expect(doc.targets[0].status).toBe('error');
    expect(doc.targets[0].error).toBe('adb install failed');
    expect(doc.targets[0].endedAt).toBeInstanceOf(Date);
  });

  it('returns null for an unknown run', async () => {
    vi.spyOn(InstallRun, 'findById').mockResolvedValue(null as never);

    expect(await reportTargetProgress('nope', 'd1', { status: 'done' })).toBeNull();
  });

  it('returns null for an unknown target on a real run', async () => {
    vi.spyOn(InstallRun, 'findById').mockResolvedValue(fakeRun() as never);

    expect(await reportTargetProgress('run-1', 'not-a-target', { status: 'done' })).toBeNull();
  });
});

describe('getInstalledDevicesForBuild', () => {
  it('reports each device only under the build it most recently, successfully received', async () => {
    vi.spyOn(buildsService, 'getBuild').mockResolvedValue(readyBuild as never);
    vi.spyOn(InstallRun, 'find').mockReturnValue({
      // Oldest first — the function relies on this order to let the later
      // write win when folding into a per-device map.
      sort: vi.fn().mockResolvedValue([
        {
          id: 'run-1',
          buildId: { toString: () => 'build-1' },
          targets: [
            { deviceUdid: 'd1', status: 'done', endedAt: new Date('2026-01-01') },
            { deviceUdid: 'd2', status: 'done', endedAt: new Date('2026-01-01') },
          ],
        },
        {
          // A later install of a *different* build onto d1 — this build.md
          // supersedes build-1 there, so d1 must not be reported for build-1
          // any more even though it really did receive it once.
          id: 'run-2',
          buildId: { toString: () => 'build-2' },
          targets: [{ deviceUdid: 'd1', status: 'done', endedAt: new Date('2026-01-02') }],
        },
      ]),
    } as never);
    vi.spyOn(devicesService, 'getDevicesByUdids').mockResolvedValue([
      { udid: 'd2', name: 'Pixel 7' },
    ] as never);

    const result = await getInstalledDevicesForBuild('build-1');

    expect(result).toEqual([
      { deviceUdid: 'd2', deviceName: 'Pixel 7', installRunId: 'run-1', installedAt: new Date('2026-01-01') },
    ]);
  });

  it('reports a null deviceName rather than guessing when the device is no longer known', async () => {
    vi.spyOn(buildsService, 'getBuild').mockResolvedValue(readyBuild as never);
    vi.spyOn(InstallRun, 'find').mockReturnValue({
      sort: vi.fn().mockResolvedValue([
        {
          id: 'run-1',
          buildId: { toString: () => 'build-1' },
          targets: [{ deviceUdid: 'gone', status: 'done', endedAt: new Date('2026-01-01') }],
        },
      ]),
    } as never);
    vi.spyOn(devicesService, 'getDevicesByUdids').mockResolvedValue([] as never);

    const result = await getInstalledDevicesForBuild('build-1');

    expect(result).toEqual([
      { deviceUdid: 'gone', deviceName: null, installRunId: 'run-1', installedAt: new Date('2026-01-01') },
    ]);
  });

  it('returns empty for an unknown build, without querying installs at all', async () => {
    vi.spyOn(buildsService, 'getBuild').mockResolvedValue(null);
    const find = vi.spyOn(InstallRun, 'find');

    expect(await getInstalledDevicesForBuild('ghost')).toEqual([]);
    expect(find).not.toHaveBeenCalled();
  });

  it('excludes a device whose package was successfully uninstalled after this install completed', async () => {
    vi.spyOn(buildsService, 'getBuild').mockResolvedValue(readyBuild as never);
    vi.spyOn(InstallRun, 'find').mockReturnValue({
      sort: vi.fn().mockResolvedValue([
        {
          id: 'run-1',
          buildId: { toString: () => 'build-1' },
          targets: [
            { deviceUdid: 'd1', status: 'done', endedAt: new Date('2026-01-01'), packageName: 'com.example.app' },
            { deviceUdid: 'd2', status: 'done', endedAt: new Date('2026-01-01'), packageName: 'com.example.app' },
          ],
        },
      ]),
    } as never);
    vi.spyOn(UninstallRun, 'find').mockResolvedValue([
      {
        packageName: 'com.example.app',
        // Only d1 was uninstalled, and only after the install completed.
        targets: [{ deviceUdid: 'd1', status: 'done', endedAt: new Date('2026-01-02') }],
      },
    ] as never);
    vi.spyOn(devicesService, 'getDevicesByUdids').mockResolvedValue([{ udid: 'd2', name: 'Pixel 7' }] as never);

    const result = await getInstalledDevicesForBuild('build-1');

    expect(result.map((d) => d.deviceUdid)).toEqual(['d2']);
  });

  it('does not exclude a device that was uninstalled and then reinstalled', async () => {
    vi.spyOn(buildsService, 'getBuild').mockResolvedValue(readyBuild as never);
    vi.spyOn(InstallRun, 'find').mockReturnValue({
      sort: vi.fn().mockResolvedValue([
        {
          id: 'run-1',
          buildId: { toString: () => 'build-1' },
          // The reinstall (Jan 3) is after the uninstall (Jan 2) mocked below.
          targets: [{ deviceUdid: 'd1', status: 'done', endedAt: new Date('2026-01-03'), packageName: 'com.example.app' }],
        },
      ]),
    } as never);
    vi.spyOn(UninstallRun, 'find').mockResolvedValue([
      {
        packageName: 'com.example.app',
        targets: [{ deviceUdid: 'd1', status: 'done', endedAt: new Date('2026-01-02') }],
      },
    ] as never);
    vi.spyOn(devicesService, 'getDevicesByUdids').mockResolvedValue([{ udid: 'd1', name: 'Pixel 7' }] as never);

    const result = await getInstalledDevicesForBuild('build-1');

    expect(result.map((d) => d.deviceUdid)).toEqual(['d1']);
  });
});
