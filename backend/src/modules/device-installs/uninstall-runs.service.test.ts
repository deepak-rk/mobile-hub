import { describe, it, expect, vi, afterEach } from 'vitest';
import { UninstallRun } from './uninstall-run.model';
import * as devicesService from '../devices/devices.service';
import {
  UnknownDeviceError,
  triggerUninstallRun,
  getPendingUninstallsForMachine,
  getActiveUninstallCountForMachine,
  reportUninstallTargetProgress,
} from './uninstall-runs.service';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('triggerUninstallRun', () => {
  it('rejects a target device that does not exist', async () => {
    vi.spyOn(devicesService, 'resolveDevice').mockResolvedValue(null);

    await expect(
      triggerUninstallRun({ packageName: 'com.example.app', project: 'demo-app', devices: [{ udid: 'ghost' }], triggeredBy: 'user-1' }),
    ).rejects.toThrow(UnknownDeviceError);
  });

  it('creates one queued target per device, carrying the package name on the run itself', async () => {
    vi.spyOn(devicesService, 'resolveDevice').mockImplementation(
      async (udid) => ({ udid, machineId: 'host-1' }) as never,
    );
    const create = vi.spyOn(UninstallRun, 'create').mockResolvedValue({ targets: [] } as never);

    await triggerUninstallRun({
      packageName: 'com.example.app',
      project: 'demo-app',
      devices: [{ udid: 'd1' }, { udid: 'd2' }],
      triggeredBy: 'user-1',
    });

    const passed = create.mock.calls[0][0] as {
      packageName: string;
      targets: { deviceUdid: string; status: string }[];
    };
    expect(passed.packageName).toBe('com.example.app');
    expect(passed.targets).toEqual([
      expect.objectContaining({ deviceUdid: 'd1', status: 'queued' }),
      expect.objectContaining({ deviceUdid: 'd2', status: 'queued' }),
    ]);
  });

  it('rejects the whole run if any one target device is unknown, without creating anything', async () => {
    vi.spyOn(devicesService, 'resolveDevice').mockImplementation(
      async (udid) => (udid === 'ghost' ? null : ({ udid, machineId: 'host-1' } as never)),
    );
    const create = vi.spyOn(UninstallRun, 'create');

    await expect(
      triggerUninstallRun({
        packageName: 'com.example.app',
        project: 'demo-app',
        devices: [{ udid: 'ok' }, { udid: 'ghost' }],
        triggeredBy: 'user-1',
      }),
    ).rejects.toThrow(UnknownDeviceError);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('getPendingUninstallsForMachine', () => {
  it('only returns targets for the requested machine that are still queued', async () => {
    vi.spyOn(UninstallRun, 'find').mockResolvedValue([
      {
        id: 'run-1',
        packageName: 'com.example.app',
        targets: [
          { deviceUdid: 'd1', machineId: 'host-1', status: 'queued' },
          { deviceUdid: 'd2', machineId: 'host-1', status: 'done' }, // already finished
          { deviceUdid: 'd3', machineId: 'host-2', status: 'queued' }, // different host
        ],
      },
    ] as never);

    const pending = await getPendingUninstallsForMachine('host-1');

    expect(pending).toEqual([{ uninstallRunId: 'run-1', deviceUdid: 'd1', packageName: 'com.example.app' }]);
  });
});

describe('getActiveUninstallCountForMachine', () => {
  it('counts in-flight targets scoped to the requested machine', async () => {
    const countDocuments = vi.spyOn(UninstallRun, 'countDocuments').mockResolvedValue(3 as never);

    const count = await getActiveUninstallCountForMachine('host-1');

    expect(count).toBe(3);
    expect(countDocuments).toHaveBeenCalledWith({
      'targets.machineId': 'host-1',
      'targets.status': { $in: ['queued', 'uninstalling'] },
    });
  });
});

describe('reportUninstallTargetProgress', () => {
  function fakeRun() {
    const doc = {
      id: 'run-1',
      targets: [{ deviceUdid: 'd1', machineId: 'host-1', status: 'queued', error: null, startedAt: null, endedAt: null }],
    };
    (doc as unknown as { save: () => Promise<void> }).save = vi.fn().mockResolvedValue(undefined);
    return doc;
  }

  it('stamps startedAt on the first non-queued report and endedAt on a terminal one', async () => {
    const doc = fakeRun();
    vi.spyOn(UninstallRun, 'findById').mockResolvedValue(doc as never);

    await reportUninstallTargetProgress('run-1', 'd1', { status: 'uninstalling' });
    expect(doc.targets[0].startedAt).toBeInstanceOf(Date);
    expect(doc.targets[0].endedAt).toBeNull();

    await reportUninstallTargetProgress('run-1', 'd1', { status: 'done' });
    expect(doc.targets[0].endedAt).toBeInstanceOf(Date);
  });

  it('returns null for an unknown run', async () => {
    vi.spyOn(UninstallRun, 'findById').mockResolvedValue(null as never);

    expect(await reportUninstallTargetProgress('nope', 'd1', { status: 'done' })).toBeNull();
  });

  it('returns null for an unknown target on a real run', async () => {
    vi.spyOn(UninstallRun, 'findById').mockResolvedValue(fakeRun() as never);

    expect(await reportUninstallTargetProgress('run-1', 'not-a-target', { status: 'done' })).toBeNull();
  });
});
