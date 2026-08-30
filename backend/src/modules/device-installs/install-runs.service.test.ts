import { describe, it, expect, vi, afterEach } from 'vitest';
import { InstallRun } from './install-run.model';
import { Build } from '../builds/build.model';
import * as buildsService from '../builds/builds.service';
import * as devicesService from '../devices/devices.service';
import {
  BuildNotReadyError,
  IncompatibleDeviceError,
  UnknownDeviceError,
  triggerInstallRun,
  getPendingInstallsForMachine,
  reportTargetProgress,
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
      select: vi.fn().mockResolvedValue([{ id: 'build-1', sizeBytes: 4242 }]),
    } as never);

    const pending = await getPendingInstallsForMachine('host-1');

    expect(pending).toEqual([
      { installRunId: 'run-1', deviceUdid: 'd1', buildId: 'build-1', platform: 'android', sizeBytes: 4242 },
    ]);
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
