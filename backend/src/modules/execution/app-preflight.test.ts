import { describe, it, expect, vi } from 'vitest';

// The real services pull in Mongoose models; the preflight logic only needs its deps.
vi.mock('../builds/builds.service', () => ({ getBuild: vi.fn() }));
vi.mock('../device-installs/install-runs.service', () => ({
  deviceKey: vi.fn(),
  getActiveInstallDeviceKeys: vi.fn(),
  getInstallRun: vi.fn(),
  getInstalledDevicesForBuild: vi.fn(),
  triggerInstallRun: vi.fn(),
}));

import { ensureAppOnDevice, PreflightDeps, PreflightTarget } from './app-preflight';

function fakeDeps(over: Partial<PreflightDeps> & { targets?: PreflightTarget[]; inFlight?: boolean[] } = {}) {
  let clock = 0;
  const targets = over.targets ?? [{ status: 'done', error: null }];
  const inFlight = over.inFlight ?? [false];
  let installed = false;
  const started: string[] = [];
  const deps: PreflightDeps = {
    buildStatus: async () => 'ready',
    isInstalled: async () => installed,
    installInFlight: async () => inFlight.shift() ?? false,
    startInstall: async (buildId) => {
      started.push(buildId);
      return 'ir1';
    },
    installTarget: async () => {
      const t = targets.length > 1 ? targets.shift()! : targets[0];
      if (t.status === 'done') installed = true;
      return t;
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    ...over,
  };
  return { deps, started, setInstalled: (v: boolean) => (installed = v) };
}

const input = {
  buildId: 'b1',
  machineId: 'host-a',
  udid: 'emulator-5554',
  triggeredBy: 'u1',
  runId: 'run-1',
  log: () => {},
  isCancelled: () => false,
  pollMs: 1000,
  timeoutMs: 10_000,
};

describe('app preflight', () => {
  it('skips the install when the build is already on the device', async () => {
    const f = fakeDeps();
    f.setInstalled(true);
    expect(await ensureAppOnDevice(input, f.deps)).toEqual({ ok: true, action: 'already_installed' });
    expect(f.started).toEqual([]);
  });

  it('installs through the install flow and re-verifies', async () => {
    const f = fakeDeps({ targets: [{ status: 'queued', error: null }, { status: 'installing', error: null }, { status: 'done', error: null }] });
    expect(await ensureAppOnDevice(input, f.deps)).toEqual({ ok: true, action: 'installed' });
    expect(f.started).toEqual(['b1']);
  });

  it('waits for an install already in flight, then finds the build installed', async () => {
    const f = fakeDeps({ inFlight: [true, true, false] });
    const busy = [true, true, false];
    f.deps.installInFlight = async () => {
      const b = busy.shift() ?? false;
      if (!b) f.setInstalled(true); // the other install was this build
      return Promise.resolve(b);
    };
    expect(await ensureAppOnDevice(input, f.deps)).toEqual({ ok: true, action: 'already_installed' });
    expect(f.started).toEqual([]);
  });

  it('reports a failed install as install_failed with the agent error', async () => {
    const f = fakeDeps({ targets: [{ status: 'error', error: 'INSTALL_FAILED_INSUFFICIENT_STORAGE' }] });
    const r = await ensureAppOnDevice(input, f.deps);
    expect(r).toMatchObject({ ok: false, errorClass: 'install_failed' });
    expect(r.ok ? '' : r.message).toContain('INSUFFICIENT_STORAGE');
  });

  it('times out an install nobody picks up', async () => {
    const f = fakeDeps({ targets: [{ status: 'queued', error: null }] });
    const r = await ensureAppOnDevice(input, f.deps);
    expect(r).toMatchObject({ ok: false, errorClass: 'install_failed' });
    expect(r.ok ? '' : r.message).toContain('still queued');
  });

  it('fails a build that is not ready as build_missing, without installing', async () => {
    const f = fakeDeps({ buildStatus: async () => 'fetching' });
    expect(await ensureAppOnDevice(input, f.deps)).toMatchObject({ ok: false, errorClass: 'build_missing' });
    expect(f.started).toEqual([]);
  });

  it('fails when a done install does not show up as installed', async () => {
    const f = fakeDeps();
    f.deps.isInstalled = async () => false;
    const r = await ensureAppOnDevice(input, f.deps);
    expect(r).toMatchObject({ ok: false, errorClass: 'install_failed' });
    expect(r.ok ? '' : r.message).toContain('does not show');
  });

  it('stops waiting when the run is cancelled', async () => {
    const f = fakeDeps({ targets: [{ status: 'queued', error: null }] });
    let n = 0;
    const result = await ensureAppOnDevice({ ...input, isCancelled: () => ++n > 2 }, f.deps);
    expect(result).toMatchObject({ ok: false, errorClass: 'cancelled' });
  });
});
