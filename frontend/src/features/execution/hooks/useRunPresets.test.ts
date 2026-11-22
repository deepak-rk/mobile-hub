import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { resolvePresetDevice, useRunPresets, type RunPresetInput } from './useRunPresets';

const STORAGE_KEY = 'mh_execution_presets';

const sample: RunPresetInput = {
  name: 'Nightly regression',
  project: 'checkout-app',
  branch: 'main',
  suite: 'regression',
  machineId: 'host-a',
  deviceUdid: 'emulator-5554',
  setupCmd: 'npm ci',
  runCmd: 'npx wdio run wdio.conf.js',
};

beforeEach(() => {
  localStorage.clear();
});

describe('useRunPresets', () => {
  it('starts empty when nothing is saved yet', () => {
    const { result } = renderHook(() => useRunPresets());
    expect(result.current.presets).toEqual([]);
  });

  it('saves a preset and persists it to localStorage', () => {
    const { result } = renderHook(() => useRunPresets());

    act(() => result.current.savePreset(sample));

    expect(result.current.presets).toHaveLength(1);
    expect(result.current.presets[0]).toMatchObject(sample);
    expect(result.current.presets[0].id).toBeTruthy();
    expect(result.current.presets[0].savedAt).toBeTruthy();

    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(stored).toHaveLength(1);
  });

  it('saving under an existing name overwrites rather than duplicating', () => {
    const { result } = renderHook(() => useRunPresets());

    act(() => result.current.savePreset(sample));
    const firstId = result.current.presets[0].id;
    act(() => result.current.savePreset({ ...sample, runCmd: 'npx wdio run smoke.conf.js' }));

    expect(result.current.presets).toHaveLength(1);
    expect(result.current.presets[0].id).not.toBe(firstId); // a fresh save, not a mutation
    expect(result.current.presets[0].runCmd).toBe('npx wdio run smoke.conf.js');
  });

  it('deletes a preset by id', () => {
    const { result } = renderHook(() => useRunPresets());
    act(() => result.current.savePreset(sample));
    const id = result.current.presets[0].id;

    act(() => result.current.deletePreset(id));

    expect(result.current.presets).toEqual([]);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual([]);
  });

  it('deleting an id that does not exist is a harmless no-op', () => {
    const { result } = renderHook(() => useRunPresets());
    act(() => result.current.savePreset(sample));

    act(() => result.current.deletePreset('does-not-exist'));

    expect(result.current.presets).toHaveLength(1);
  });

  it('keeps presets sorted by name', () => {
    const { result } = renderHook(() => useRunPresets());
    act(() => result.current.savePreset({ ...sample, name: 'Zebra suite' }));
    act(() => result.current.savePreset({ ...sample, name: 'Alpha suite' }));

    expect(result.current.presets.map((p) => p.name)).toEqual(['Alpha suite', 'Zebra suite']);
  });

  it('degrades to empty instead of crashing when localStorage holds malformed JSON', () => {
    localStorage.setItem(STORAGE_KEY, '{not valid json');
    const { result } = renderHook(() => useRunPresets());
    expect(result.current.presets).toEqual([]);
  });

  it('degrades to empty instead of crashing when localStorage holds a non-array value', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ not: 'an array' }));
    const { result } = renderHook(() => useRunPresets());
    expect(result.current.presets).toEqual([]);
  });
});

describe('resolvePresetDevice', () => {
  const hostA = { machineId: 'host-a', udid: 'emulator-5554', name: 'A' };
  const hostB = { machineId: 'host-b', udid: 'emulator-5554', name: 'B' };
  const physical = { machineId: 'host-b', udid: 'R58N12345', name: 'Phone' };

  it('matches host + udid, not the same udid on another host', () => {
    expect(resolvePresetDevice({ machineId: 'host-b', deviceUdid: 'emulator-5554' }, [hostA, hostB])).toBe(hostB);
  });

  it('resolves nothing when the saved host no longer has that udid', () => {
    expect(resolvePresetDevice({ machineId: 'host-c', deviceUdid: 'emulator-5554' }, [hostA, hostB])).toBeUndefined();
  });

  it('resolves a legacy udid-only preset when exactly one device has that udid', () => {
    expect(resolvePresetDevice({ deviceUdid: 'R58N12345' }, [hostA, hostB, physical])).toBe(physical);
    expect(resolvePresetDevice({ machineId: '', deviceUdid: 'emulator-5554' }, [hostA])).toBe(hostA);
  });

  it('leaves a legacy udid-only preset unselected when the udid exists on more than one host', () => {
    expect(resolvePresetDevice({ deviceUdid: 'emulator-5554' }, [hostA, hostB])).toBeUndefined();
  });

  it('resolves nothing for a preset saved without a device', () => {
    expect(resolvePresetDevice({ machineId: '', deviceUdid: '' }, [hostA])).toBeUndefined();
  });
});

describe('legacy presets', () => {
  it('still load when saved before presets carried a machineId', () => {
    const legacy: Partial<RunPresetInput> = { ...sample };
    delete legacy.machineId;
    localStorage.setItem(STORAGE_KEY, JSON.stringify([{ ...legacy, id: 'old', savedAt: '2026-01-01T00:00:00.000Z' }]));

    const { result } = renderHook(() => useRunPresets());

    expect(result.current.presets).toHaveLength(1);
    expect(result.current.presets[0].machineId).toBeUndefined();
    expect(result.current.presets[0].deviceUdid).toBe('emulator-5554');
  });
});
