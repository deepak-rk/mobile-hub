import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRunPresets, type RunPresetInput } from './useRunPresets';

const STORAGE_KEY = 'mh_execution_presets';

const sample: RunPresetInput = {
  name: 'Nightly regression',
  project: 'checkout-app',
  branch: 'main',
  suite: 'regression',
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
